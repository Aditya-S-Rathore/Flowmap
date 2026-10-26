export const graphqlApi = {
  async mutationRequest(doc: unknown, operation: string, variables: unknown) {
    return { doc, operation, variables };
  },
};
