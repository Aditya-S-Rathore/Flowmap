import { Node } from "ts-morph";
import type { FlowMapPlugin } from "@flowmap/core";

/** `export const fooAction = createAsyncThunk("foo", async () => api(...))` → ClientCall node. dispatch(fooAction()) links via core call edges. */
export const reduxThunk: FlowMapPlugin = {
  id: "redux-thunk",
  detect: (pkg) => !!(pkg.dependencies?.["@reduxjs/toolkit"] ?? pkg.dependencies?.["redux-thunk"]),

  extract(ctx) {
    for (const fn of ctx.fns) {
      let init: Node = fn.body;
      while (Node.isAsExpression(init) || Node.isParenthesizedExpression(init)) init = init.getExpression();
      if (!Node.isCallExpression(init) || !/createAsyncThunk$/.test(init.getExpression().getText())) continue;
      fn.node.kind = "ClientCall";
      const type = init.getArguments()[0];
      if (type && (Node.isStringLiteral(type) || Node.isNoSubstitutionTemplateLiteral(type))) fn.node.attrs.actionType = type.getLiteralValue();
    }
  },
};
