import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { SessionStore } from './core/session.store';
import { WorkspaceShellComponent } from './workspace/workspace-shell.component';
@Component({ selector: 'ce-root', standalone: true, imports: [FormsModule, MatButtonModule, MatFormFieldModule, MatInputModule, WorkspaceShellComponent], changeDetection: ChangeDetectionStrategy.OnPush,
template: `<a class="skip-link" href="#main-content">Saltar al contenido principal</a>
<header class="app-header"><img class="brand-mark" src="/consolidation-engine.svg" width="40" height="40" alt=""/><div><strong>ConsolidationEngine</strong><span>Validación de informes regulatorios</span></div><span class="session-badge">Sesión local</span></header>
<main id="main-content" tabindex="-1">
@if (session.error(); as error) { <p class="error" role="alert">{{ error }}</p> }
@if (!session.connected()) { <section class="welcome-panel"><h1>Conectar con la sesión local</h1><button mat-flat-button (click)="session.connect()" [disabled]="session.pending()">{{ session.pending() ? 'Conectando…' : 'Conectar' }}</button></section> }
@else if (session.workspace()) { <ce-workspace-shell/> }
@else { <section class="welcome-panel"><p class="eyebrow">UN NUEVO CONJUNTO</p><h1>De los datos a los resultados</h1><p>Carga tus informes, comprueba las reglas y revisa cada cambio antes de aplicarlo.</p><form (ngSubmit)="session.create(name)"><mat-form-field appearance="outline"><mat-label>Nombre del conjunto</mat-label><input matInput id="workspace-name-input" name="name" [(ngModel)]="name" maxlength="100" required placeholder="Ej. Cierre trimestral"/></mat-form-field><button mat-flat-button type="submit" [disabled]="session.pending() || !name.trim()">Crear conjunto</button></form><p class="muted">La sesión es temporal. Descarga tus resultados antes de cerrar el conjunto o reiniciar el servidor.</p></section> }
</main>` })
export class AppComponent { readonly session = inject(SessionStore); name = ''; constructor() { void this.session.connect(); } }
