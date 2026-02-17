const Promise = require('bluebird');
const validate_1 = require("gettext-extractor/dist/utils/validate");
const parser_1 = require("gettext-extractor/dist/parser");
const ts = require("typescript");
const config = require('./config.js');

// vue-template-compiler for proper .vue template parsing
// (TS parser cannot reliably parse HTML — it may enter JSX mode or produce
// broken ASTs, causing translation calls in <template> to be missed)
let vueCompiler;
try { vueCompiler = require('vue-template-compiler'); } catch(e) {}

module.exports = function (jsParser) {

    jsParser.parseSourceFile = function(source, fileName, options = {}) {
        validate_1.Validate.required.string({ source });
        validate_1.Validate.optional.nonEmptyString({ fileName });
        this.validateParseOptions(options);

        if (!this.extractors.length) {
            throw new Error(`Missing extractor functions. Provide them when creating the parser or dynamically add extractors using 'addExtractor()'`);
        }
        if (options && options.transformSource) {
            source = options.transformSource(source);
        }

        let messages;
        if (vueCompiler && fileName && fileName.endsWith('.vue')) {
            messages = jsParser.parseVueSource(source, fileName, options);
        } else {
            messages = jsParser.parseSource(source, fileName || Parser.STRING_LITERAL_FILENAME, options);
        }
        for (let message of messages) {
            this.builder.addMessage(message);
        }

        this.stats && this.stats.numberOfParsedFiles++;
        if (messages.length) {
            this.stats && this.stats.numberOfParsedFilesWithMessages++;
        }

        return source;
    };

    jsParser.parseSource = function(source, fileName, options = {}) {
        let sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, options.scriptKind);
        return jsParser.parseNodeSource(sourceFile, sourceFile, options.lineNumberStart || 1);
    };

    jsParser.parseVueSource = function(source, fileName, options) {
        var parsed = vueCompiler.parseComponent(source);
        var messages = [];

        // 1. Parse <script> with TS — it's valid JS, so TS handles it correctly
        if (parsed.script && parsed.script.content) {
            var newlinesBefore = (source.substring(0, parsed.script.start).match(/\n/g) || []).length;
            var scriptMessages = jsParser.parseSource(parsed.script.content, fileName, {
                lineNumberStart: newlinesBefore + 1,
                scriptKind: options.scriptKind
            });
            messages = messages.concat(scriptMessages);
        }

        // 2. Parse <template> expressions via vue-template-compiler AST
        //    (each expression is valid JS, so TS parser handles it correctly)
        if (parsed.template && parsed.template.content) {
            var compiled = vueCompiler.compile(parsed.template.content);
            if (compiled.ast) {
                var expressions = [];

                function walkAst(node) {
                    if (!node) return;
                    // type 2 = interpolation {{ }}
                    if (node.type === 2 && node.expression) {
                        expressions.push(node.expression);
                    }
                    // dynamic attributes (:attr) and directives (v-*)
                    if (node.attrsMap) {
                        Object.keys(node.attrsMap).forEach(function(attr) {
                            if (attr.charAt(0) === ':' || attr.indexOf('v-') === 0) {
                                expressions.push(node.attrsMap[attr]);
                            }
                        });
                    }
                    if (node.children) {
                        node.children.forEach(function(child) { walkAst(child); });
                    }
                    if (node.ifConditions) {
                        node.ifConditions.forEach(function(cond) {
                            if (cond.block && cond.block !== node) walkAst(cond.block);
                        });
                    }
                    if (node.scopedSlots) {
                        Object.values(node.scopedSlots).forEach(function(slot) { walkAst(slot); });
                    }
                }

                walkAst(compiled.ast);

                expressions.forEach(function(expr) {
                    try {
                        var exprMessages = jsParser.parseSource(expr, fileName);
                        messages = messages.concat(exprMessages);
                    } catch(e) { /* ignore parse errors */ }
                });
            }
        }

        return messages;
    };

    jsParser.parseNodeSource = function(node, sourceFile, lineNumberStart){
        let messages = [];
        let addMessageCallback = parser_1.Parser.createAddMessageCallback(messages, sourceFile.fileName, () => {
            let location = sourceFile.getLineAndCharacterOfPosition(node.getStart());
            return lineNumberStart + location.line;
        });
        let replaceCallExpression = function(msg){
            addMessageCallback(msg);
            jsParser.addReplaceMessageNode(msg, node, sourceFile.fileName);
        };
        for (let extractor of jsParser.extractors) {
            extractor(node, sourceFile, replaceCallExpression);
        }
        var results = ts.forEachChild(node, n => {
            messages = messages.concat(jsParser.parseNodeSource(n, sourceFile, lineNumberStart));
        });

        // парсинг и перебор строковых литералов
        if ( node.getStart() > 0 && (ts.isStringLiteral(node) || ts.isRegularExpressionLiteral(node)) ){
            let text = ts.isRegularExpressionLiteral(node) ? node.getText().slice(1) : node.text;
            let srcText = ts.createSourceFile(sourceFile.fileName, text, ts.ScriptTarget.Latest, true);
            let lineNumberStartText = lineNumberStart+ sourceFile.getLineAndCharacterOfPosition(node.getStart()).line;
            ts.forEachChild(srcText, n => {
                messages = messages.concat(jsParser.parseNodeSource(n, srcText, lineNumberStartText));
            });
        }

        return messages;
    }

    jsParser.addReplaceMessageNode = function(message, node, fileName){
        if ( !jsParser.replacements )
            jsParser.replacements = [];

        jsParser.replacements.push({ message, node, fileName });
    };

    jsParser.replaceMessageNodes = function(source, fileName, translationObj){
        if ( !jsParser.replacements ) return Promise.reject();

        return new Promise(function(resolve, reject){
            let resmsg = {};
            let translations = {};

            // transform items to { 'context:text': item }
            translationObj && translationObj.items.forEach(item => {
                translations[(item.msgctxt ? item.msgctxt+':' : '')+item.msgid] = item;
            });

            jsParser.replacements.forEach(function(item){
                if (fileName.replace(/\\/g, '/').indexOf(item.fileName) >= 0) {
                    let replaceItem = getItemToReplace(item.node, item.message, translations);
                    if (!resmsg[replaceItem.srcTxt]) {
                        resmsg[replaceItem.srcTxt] = replaceItem.dstStr;
                    }
                }
            });

            for (let srcTxt in resmsg) {
                let regTxt = new RegExp(srcTxt.replace(/([\^\$\(\)\[\]\{\}\*\.\+\?\|\\])/gi, "\\$1"), 'g');
                let dstStr = resmsg[srcTxt];
                source = source.replace(regTxt, dstStr);
            }

            resolve(source);
        });
    };

    return jsParser;
};

function getItemToReplace(node, message, translations){
    let poitem = translations[(message.context ? message.context+':' : '')+message.text] || false,
        resultText;

    if ( message.textPlural )
        resultText = resolveNGettext(node, message, poitem);
    else
        resultText = resolveGettext(node, message, poitem);

    return {
        srcTxt: node.getText(),
        dstStr: resultText
    };
}

function resolveGettext(node, message, item){
    let argsNum = message.context ? 1 : 0,
        resultText;

    if (item) {
        let text = (item.nplurals > 1 ? item.msgstr[0] : item.msgstr) || item.msgid;
        let isSingleQuote = node.arguments[argsNum].getText().charCodeAt(0) === 39;
        resultText = ts.getLiteralText(ts.createLiteral(text, isSingleQuote), '', true, false);
    } else {
        resultText = node.arguments[argsNum].getText();
    }

    return resultText;
}

function resolveNGettext(node, message, item){
    let argumentsArray = item ? (item.nplurals > 1 && item.msgstr[0] ? item.msgstr : [item.msgid, item.msgid_plural]) : [];
    let allCallNames = node.expression.getText();
    let callName = !ts.isIdentifier(node.expression) ? node.expression.name.getText() : node.expression.getText();

    if ( !argumentsArray.length )
        return node.getText();

    let isSingleQuote = node.arguments[0] && node.arguments[0].getText().charCodeAt(0) === 39;
    argumentsArray = argumentsArray.map(function(el){
        return ts.getLiteralText(ts.createLiteral(el, isSingleQuote), '', true, false);
    });

    if ( config.calleeNames.npgettext.indexOf(callName) >= 0 ) {
        argumentsArray.unshift(''); // add content argument for ngettext function
    }

    // for number to call ngettext
    argumentsArray.push( ts.getLastChild(node).getText() );

    return allCallNames + '('+argumentsArray.join(',') + ')';
}
