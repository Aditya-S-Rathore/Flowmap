import { useQuery } from "@apollo/client";
import { Link } from "react-router-dom";
import { GHOST } from "../graphql/user";
import { PATHS } from "../constants";
import { helper } from "./missing-helper";

export default function Home() {
  useQuery(GHOST);
  return <div>{helper}<Link to={PATHS.PROFILE}>Profile</Link></div>;
}
