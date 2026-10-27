import {demand} from '../errors.js';

const invalidTransition=/\b(?:hypothes(?:is|es)|explanations?)\s+(?:(?:status|state)\s+)?(?:(?:is|are|was|were|has(?:\s+been)?|have(?:\s+been)?)\s+)?(?:moved|changed|went|transitioned|advanced|progressed|shifted)\s+(?:from\s+(?:proposed|accepted|rejected|needs[_ -]evidence)\s+)?to\s+(?:passed|failed|proven|confirmed|validated)\b/iu;

/** A check outcome is never a saved explanation state. Reject explicit status
 * promotion in prose instead of rewriting the model's text or domain truth. */
export function assertDraftStatusLanguage(text:string):void {
 const normalized=text.normalize('NFKC').replace(/\p{Default_Ignorable_Code_Point}/gu,'');
 demand(!/\b(?:hypothes(?:is|es)|explanations?)\s+(?:(?:status|state)\s+)?(?:(?:is|are|was|were|has(?:\s+been)?|have(?:\s+been)?|changed\s+to|became)\s+)?(?:now\s+)?(?:passed|failed|proven|confirmed|validated)\b/iu.test(normalized)&&!invalidTransition.test(normalized),'INVALID_MODEL_PROPOSAL','Describe the saved check outcome separately from the explanation state.',409);
}

/** Product language applies only to prose, never IDs, keys, enums or bindings. */
export const AGENT_PROSE_LANGUAGE='Use plain prose: groups, explanations, earlier/later period; agent, never AI. Keep IDs/keys/enums exact.';
