import {CPU_WORK_STAGES} from '@podjs/framework/cpu-work';
/** Closed release diagnostics; values name code phases, never user objects. */
export const RESTORE_CPU_STAGES=[...CPU_WORK_STAGES,'manifest-plan','records-validate','records-parse','projection-rebuild','record-diff','record-merge','book-validate','book-match','alias-match','overlay-index'] as const;
