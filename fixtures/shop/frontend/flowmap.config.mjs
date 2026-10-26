export default {
  name: "frontend",
  plugins: ["react-router", "redux-thunk", "apollo", "http-clients"],
  connect: ["../backend"],
  clients: [{ call: "graphqlApi.mutationRequest", opArg: 1, docArg: 0 }],
};
