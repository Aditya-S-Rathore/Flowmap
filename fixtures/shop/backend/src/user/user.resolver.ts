import { Args, Mutation, Query, Resolver } from "@nestjs/graphql";
import { UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../guards/jwt.guard";
import { GqlUser } from "../guards/gql-user.decorator";
import { UserService } from "./user.service";

@Resolver("User")
@UseGuards(JwtAuthGuard)
export class UserResolver {
  constructor(private readonly userService: UserService) {}

  @Mutation("setNickname")
  async setNickname(@Args("userId") userId: number, @Args("nickname") nickname: string) {
    return this.userService.setNickname(userId, nickname);
  }

  @Query("me")
  async me(@GqlUser() user: { id: number }) {
    return this.userService.getUser(user.id);
  }

  @Mutation("updateProfile")
  async updateProfile(@GqlUser() user: { id: number }, @Args("input") input: { nickname: string }) {
    return this.userService.rename(user.id, input.nickname);
  }
}

@Resolver("Stats")
export class StatsResolver {
  @Query("stats")
  async stats() {
    return 1;
  }
}
