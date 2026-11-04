import { Injectable, signal } from '@angular/core';
export type WorkspaceStage = 'import' | 'validation' | 'preview' | 'exports';
@Injectable()
export class WorkspaceViewStore { readonly stage = signal<WorkspaceStage>('import'); }
