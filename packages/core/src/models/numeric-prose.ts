import type {FaultlineModelResponse} from '../../../contracts/src/generated.js';
import {DomainError} from '../errors.js';

const cardinals = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety', 'hundred', 'thousand', 'million', 'billion', 'trillion'];
const ordinals = ['zeroth', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth', 'thirteenth', 'fourteenth', 'fifteenth', 'sixteenth', 'seventeenth', 'eighteenth', 'nineteenth', 'twentieth', 'thirtieth', 'fortieth', 'fiftieth', 'sixtieth', 'seventieth', 'eightieth', 'ninetieth', 'hundredth', 'thousandth', 'millionth', 'billionth', 'trillionth'];
const numberWords = new Set([...cardinals, ...ordinals, ...cardinals.map(word => word + 's'), ...ordinals.map(word => word + 's'), 'half', 'halves', 'quarter', 'quarters', 'dozen', 'dozens', 'once', 'twice', 'thrice', 'double', 'doubled', 'triple', 'tripled', 'quadruple', 'quadrupled', 'halved', 'quartered']);
const numericSymbol = /\p{N}|[%‰‱٪]/u;
const errorCode = 'MODEL_NUMERIC_CLAIM_UNSUPPORTED';
const errorMessage = 'Model prose must be number-free. Use deterministic metric panels and cited evidence for quantitative values.';

/** Supplementary JSON Schema regex. Runtime normalization and ignorable-character
 * checks below remain authoritative; providers differ in regex support. */
function wordPattern(words:readonly string[]):string {
  type Trie={end:boolean;next:Map<string,Trie>};
  const root:Trie={end:false,next:new Map()};
  for(const word of words){let node=root;for(const letter of word){let child=node.next.get(letter);if(!child){child={end:false,next:new Map()};node.next.set(letter,child);}node=child;}node.end=true;}
  const render=(node:Trie):string=>{const choices=[...node.next].sort(([a],[b])=>a.localeCompare(b)).map(([letter,child])=>'['+letter+letter.toUpperCase()+']'+render(child));const value=choices.length===1?choices[0]!:choices.length?'(?:'+choices.join('|')+')':'';return node.end&&value?'(?:'+value+')?':value;};
  return render(root);
}
export const NUMBER_FREE_MODEL_TEXT_PATTERN='^(?![\\s\\S]*\\b'+wordPattern([...numberWords])+'\\b)[^\\p{N}%‰‱٪]*$';
export class ModelNumericProseError extends DomainError {
  readonly issue:Readonly<{kind:'number_symbol'|'number_word';word?:string}>;
  constructor(kind:'number_symbol'|'number_word',word?:string){
    super(errorCode,errorMessage,422);
    // Diagnostics expose only a member of the product's finite forbidden list.
    this.issue=Object.freeze(kind==='number_word'&&typeof word==='string'&&numberWords.has(word)?{kind,word}:{kind:'number_symbol'});
  }
}

function inspect(text: string): void {
  // Check raw Unicode numbers as well: NFKC turns some numeric letters (for
  // example Roman numeral symbols) into ordinary alphabetic characters.
  const normalized = text.normalize('NFKC').toLowerCase();
  if (numericSymbol.test(text) || numericSymbol.test(normalized)) throw new ModelNumericProseError('number_symbol');
  // Scan complete letter tokens, not substrings such as "one" in "someone".
  // The additional finite scan detects ignorable separators within a spelling,
  // without parsing markup or allowing embedded instructions to execute.
  for (const value of [normalized, normalized.replace(/\p{Default_Ignorable_Code_Point}/gu, '')]) {
    for (const match of value.matchAll(/\p{L}+/gu)) if (numberWords.has(match[0])) throw new ModelNumericProseError('number_word',match[0]);
  }
}

export function assertNumberFreeModelText(text: string): void {
  inspect(text);
}

/** Conservative V1 prose policy, not a universal factual or semantic verifier.
 * The caller validates the bounded canonical schema before invoking this guard.
 * IDs, hashes, enums, indexes and structural numbers are not inspected.
 */
export function assertNumberFreeModelProse(value: FaultlineModelResponse): void {
  for (const hypothesis of value.hypotheses) {
    inspect(hypothesis.title); inspect(hypothesis.statement); inspect(hypothesis.falsifier);
    for (const missing of hypothesis.missing_evidence) inspect(missing);
    // Current model-response omits this manual-hypothesis field. Checking it if
    // present does not change the schema or authorize an additional field.
    if (Object.hasOwn(hypothesis, 'mechanism_description')) {
      const mechanism = (hypothesis as typeof hypothesis & {mechanism_description?: unknown}).mechanism_description;
      if (typeof mechanism === 'string') inspect(mechanism);
    }
  }
  for (const sentence of value.draft_sentences) inspect(sentence.text);
  for (const question of value.questions) inspect(question);
  for (const limitation of value.limitations) inspect(limitation);
}
