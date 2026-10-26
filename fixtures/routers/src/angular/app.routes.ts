import { Routes } from "@angular/router";
import { HeroesComponent } from "./heroes.component";

export const routes: Routes = [
  { path: "heroes", component: HeroesComponent },
  { path: "heroes/:id", loadComponent: () => import("./hero-detail.component").then((m) => m.HeroDetailComponent) },
];
