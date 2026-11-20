/** Authenticated body window. Recheck after staging and immediately before publication. */
export interface PublicationDeadline {
 readonly expiresAtMillis:number;
 check():void;
}
