import {demand} from './errors.js';

const INSTANCE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;

export function parsePgBossInstanceName(value:string|undefined):string|undefined {
 if(value===undefined)return undefined;
 demand(INSTANCE_NAME.test(value),'CONFIGURATION','PG_BOSS_INSTANCE_NAME must be 1-63 ASCII letters, digits, dots, underscores or hyphens, starting with a letter or digit.');
 return value;
}
