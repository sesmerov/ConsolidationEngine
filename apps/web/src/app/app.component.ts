import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { SessionStore } from './core/session.store';
import { WorkspaceShellComponent } from './workspace/workspace-shell.component';
@Component({ selector: 'ce-root', standalone: true, imports: [DatePipe, FormsModule, MatButtonModule, MatFormFieldModule, MatInputModule, WorkspaceShellComponent], changeDetection: ChangeDetectionStrategy.OnPush,
template: `<a class="skip-link" href="#main-content">Saltar al contenido principal</a>
<header class="app-header"><img class="brand-mark" src="/consolidation-engine.svg" width="40" height="40" alt=""/><div><strong>ConsolidationEngine</strong><span>Validación de informes regulatorios</span></div><span class="session-badge">{{session.hosted() ? 'Demo pública' : 'Sesión local'}}</span></header>
<main id="main-content" tabindex="-1">
@if (session.error(); as error) { <p class="error" role="alert">{{ error }}</p> }
@if (session.connected() && session.expiryWarning()) { <p class="notice" role="status">La sesión termina a las {{session.metadata()?.expiresAt | date:'HH:mm'}} si no realizas otra acción. Descarga los resultados que quieras conservar.</p> }
@if (!session.connected()) { <section class="welcome-panel"><h1>{{session.hosted() ? 'Prueba el flujo con datos sintéticos' : 'Conectar con la sesión local'}}</h1>@if(session.hosted()){<p>Esta demo es temporal y cada sesión es independiente. Usa los ejemplos incluidos; no cargues informes reales ni datos confidenciales.</p>}<button mat-flat-button class="ce-primary-action" (click)="session.hosted() ? session.startDemo() : session.connect()" [disabled]="session.pending()">{{ session.pending() ? 'Conectando…' : session.hosted() ? 'Iniciar o recuperar demo' : 'Conectar' }}</button></section> }
@else if (session.workspace()) { <ce-workspace-shell/> }
@else { <section class="welcome-panel"><p class="eyebrow">UN NUEVO CONJUNTO</p><h1>De los datos a los resultados</h1><p>Carga tus informes, comprueba las reglas y revisa cada cambio antes de aplicarlo.</p><form (ngSubmit)="session.create(name)"><mat-form-field appearance="outline"><mat-label>Nombre del conjunto</mat-label><input matInput id="workspace-name-input" name="name" [(ngModel)]="name" maxlength="100" required placeholder="Ej. Cierre trimestral"/></mat-form-field><button mat-flat-button type="submit" [disabled]="session.pending() || !name.trim()">Crear conjunto</button></form><p class="muted">La sesión es temporal. Descarga tus resultados antes de cerrar{{session.hosted() ? ' o dejar que caduque.' : ' el conjunto o reiniciar el servidor.'}}</p></section> }
</main>` })
export class AppComponent { readonly session = inject(SessionStore); name = ''; constructor() { void this.session.connect(); } }
