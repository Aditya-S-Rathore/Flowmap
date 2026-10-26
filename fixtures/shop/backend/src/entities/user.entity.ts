import { Entity, Column, ManyToOne, PrimaryGeneratedColumn } from "typeorm";
import { Org } from "./org.entity";

@Entity("users")
export class User {
  @PrimaryGeneratedColumn() id: number;
  @Column() nickname: string;
  @ManyToOne(() => Org) org: Org;
}
