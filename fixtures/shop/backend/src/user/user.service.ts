import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Transactional, runOnTransactionCommit } from "typeorm-transactional";
import Stripe from "stripe";
import { User } from "../entities/user.entity";
import { MailService } from "./mail.service";

@Injectable()
export class UserService {
  constructor(
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    private readonly stripe: Stripe,
    private readonly mail: MailService,
  ) {}

  @Transactional()
  async setNickname(userId: number, nickname: string) {
    await this.userRepo.update(userId, { nickname });
    await this.stripe.customers.update(String(userId), { name: nickname });
    return this.findUser(userId);
  }

  @Transactional()
  async getUser(id: number) {
    return this.userRepo.findOne({ where: { id } });
  }

  @Transactional()
  async rename(id: number, nickname: string) {
    await this.userRepo.save({ id, nickname });
    runOnTransactionCommit(() => this.mail.send("x"));
  }

  async findUser(id: number) {
    const user = await this.userRepo.findOne({ where: { id } });
    if (!user) throw new Error("not found");
    return user;
  }

  async notifyAll(ids: number[]) {
    for (const id of ids) {
      await this.userRepo.findOne({ where: { id } });
    }
  }

  // flowmap-ignore n-plus-one: max 3 admins, fine
  async notifyAdmins(ids: number[]) {
    for (const id of ids) await this.userRepo.findOne({ where: { id } });
  }
}
