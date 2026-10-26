import { createAsyncThunk } from "@reduxjs/toolkit";
import { graphqlApi } from "@api/graphql";
import { SET_NICKNAME } from "../graphql/user";
import { API } from "../constants";

export const setNicknameAction = createAsyncThunk("user/setNickname", async (vars: { userId: number; nickname: string }) => {
  return graphqlApi.mutationRequest(SET_NICKNAME, API.MUTATION.SET_NICKNAME, vars);
});
