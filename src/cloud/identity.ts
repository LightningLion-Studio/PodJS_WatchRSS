/** Credential refresh and entitlement changes keep the same cloud authorization owner. */
export function cloudAccountIdentity(state:{userId:string;backendBaseUrl:string}|null){return JSON.stringify([state?.userId,state?.backendBaseUrl]);}
