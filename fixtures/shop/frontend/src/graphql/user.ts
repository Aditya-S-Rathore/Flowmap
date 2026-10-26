import { gql } from "@apollo/client";

export const SET_NICKNAME = gql`
  mutation SetNickname($userId: Int!, $nickname: String!) {
    setNickname(userId: $userId, nickname: $nickname) { id }
  }
`;

export const GHOST = gql`
  query Ghost {
    removedOperation { id }
  }
`;
