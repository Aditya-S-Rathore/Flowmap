import { lazy } from "react";
import { PATHS } from "./constants";
import Home from "pages/Home";

const Profile = lazy(() => import("./pages/Profile"));

export const routes = [
  { path: PATHS.PROFILE, component: Profile, isAuthen: true },
  { path: "/", component: Home },
  { path: "/legacy-report", component: Home },
];
