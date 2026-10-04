import {expect,test} from "bun:test";
import {readFileSync} from "node:fs";
import ts from "typescript";
import {parseClassLiteral} from "../node_modules/@pocketjs/framework/framework/compiler/tailwind.ts";

/** The compiler silently drops a whole class literal when one token is unsupported. */
test("UI class literals are accepted by the package compiler", () => {
  const invalid:string[]=[];
  let checked=0;
  for(const file of new Bun.Glob("src/**/*.tsx").scanSync(".")){
    const source=ts.createSourceFile(file,readFileSync(file,"utf8"),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
    const check=(value:string,node:ts.Node)=>{
      checked++;
      try{if(parseClassLiteral(value))return;}catch{}
      const line=source.getLineAndCharacterOfPosition(node.getStart(source)).line+1;
      invalid.push(`${file}:${line} ${value}`);
    };
    const values=(node:ts.Expression)=>{
      if(ts.isStringLiteral(node)||ts.isNoSubstitutionTemplateLiteral(node)){check(node.text,node);return;}
      if(ts.isParenthesizedExpression(node)){values(node.expression);return;}
      if(ts.isConditionalExpression(node)){values(node.whenTrue);values(node.whenFalse);return;}
      if(ts.isBinaryExpression(node)&&[ts.SyntaxKind.BarBarToken,ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind)){
        values(node.left);values(node.right);
      }
    };
    const visit=(node:ts.Node)=>{
      if(ts.isJsxAttribute(node)&&node.name.getText(source)==="class"&&node.initializer){
        const initial=node.initializer;
        if(ts.isStringLiteral(initial))check(initial.text,initial);
        else if(ts.isJsxExpression(initial)&&initial.expression)values(initial.expression);
      }
      ts.forEachChild(node,visit);
    };
    visit(source);
  }
  expect(checked).toBeGreaterThan(700);
  expect(invalid).toEqual([]);
});
