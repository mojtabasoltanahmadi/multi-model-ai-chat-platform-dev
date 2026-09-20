import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from '../users/user.entity';
import { Message } from '../messages/message.entity';
import { AiModel } from '../models/ai-model.entity';

@Entity('conversations')
export class Conversation {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 200, default: 'گفتگوی جدید' })
  title: string;

  @Index()
  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, (user) => user.conversations, {
    nullable: false,
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @OneToMany(() => Message, (message) => message.conversation)
  messages: Message[];

  /**
   * The model explicitly selected for this conversation (null = none chosen
   * yet — sends then resolve the system default). This is the single source
   * of truth the client restores after a refresh or a conversation switch;
   * it is only written by the model-selection endpoint, never recomputed
   * from the default. SET NULL: deleting the model row never touches the
   * conversation — it just follows the default again.
   */
  @Column({ name: 'model_id', type: 'uuid', nullable: true })
  modelId: string | null;

  @ManyToOne(() => AiModel, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'model_id' })
  model: AiModel | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
