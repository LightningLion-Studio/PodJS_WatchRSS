import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
import {parseClassLiteral} from '/home/wilf/data/PodJS/podjs-watch/vendor/pocketjs/framework/compiler/tailwind.ts';

test('intro classes are accepted by the actual PodJS compiler instead of silently dropped',()=>{
 let checked=0;
 for(const file of ['OnboardingScreen','OnboardingCustomizationScreen','OnboardingNetworkScreen','PrivacyPolicyConsentScreen','ReaderTitleEntry','StartupGate']){
  const source=readFileSync(new URL(`../src/ui/${file}.tsx`,import.meta.url),'utf8');
  const literals=[...source.matchAll(/class="([^"]+)"/g)].map(match=>match[1]);
  for(const expression of source.matchAll(/class=\{([^}]+)\}/g)){
   literals.push(...[...expression[1].matchAll(/['"]([^'"]+)['"]/g)].map(match=>match[1]));
  }
  for(const literal of literals){expect(parseClassLiteral(literal),`${file}: ${literal}`).not.toBeNull();checked++;}
 }
 expect(checked).toBeGreaterThan(50);
});
