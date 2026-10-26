import { Entity, PrimaryGeneratedColumn } from "typeorm";

@Entity()
export class Org {
  @PrimaryGeneratedColumn() id: number;
}
