import { Injectable } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { UserService } from "../user/user.service";

@Injectable()
export class CleanupJob {
  constructor(private readonly users: UserService) {}

  @Cron("0 3 * * *")
  async run() {
    await this.users.notifyAll([1, 2]);
  }
}
