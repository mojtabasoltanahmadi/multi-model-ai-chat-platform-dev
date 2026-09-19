import { Module } from '@nestjs/common';
import { AiProviderService } from './ai-provider.service';
import { MockAdapter } from './adapters/mock.adapter';
import { OpenAiCompatibleAdapter } from './adapters/openai-compatible.adapter';
import { AnthropicAdapter } from './adapters/anthropic.adapter';
import { GoogleAdapter } from './adapters/google.adapter';

@Module({
  providers: [
    MockAdapter,
    OpenAiCompatibleAdapter,
    AnthropicAdapter,
    GoogleAdapter,
    AiProviderService,
  ],
  exports: [AiProviderService],
})
export class AiModule {}
