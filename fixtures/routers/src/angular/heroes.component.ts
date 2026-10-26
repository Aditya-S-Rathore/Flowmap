import { Component } from "@angular/core";
import { HttpClient } from "@angular/common/http";
import { Router } from "@angular/router";

@Component({ selector: "app-heroes", template: `<a routerLink="/heroes/1">First</a>` })
export class HeroesComponent {
  constructor(private http: HttpClient, private router: Router) {}
  ngOnInit() {
    this.http.get("/api/heroes");
  }
  open(id: number) {
    this.router.navigate(["/heroes", id]);
  }
}
