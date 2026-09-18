import { Injectable } from '@nestjs/common';
import { ProviderAdapter, ProviderEvent } from '../provider-adapter';

const MOCK_RESPONSE = [
  'سلام! این یک پاسخ آزمایشی از مدل ماک (Mock) است. ',
  'پلتفرم درست کار می‌کند و پیام شما با موفقیت دریافت شد. ',
  'برای استفاده از یک مدل واقعی، مدیر سیستم می‌تواند از پنل مدیریت ',
  'یک مدل با نوع «openai-compatible» و کلید API معتبر بسازد.',
].join('');

/**
 * Canned streaming adapter — the first-class provider for demos and tests.
 * Needs no API key and no network; chunking mimics real token pacing so the
 * UI streaming path is exercised end to end.
 */
@Injectable()
export class MockAdapter implements ProviderAdapter {
  async *streamChat(): AsyncGenerator<ProviderEvent> {
    // Small delay between chunks so streaming is visible in the UI.
    const chunks = MOCK_RESPONSE.match(/\S+\s*/g) ?? [MOCK_RESPONSE];
    for (const chunk of chunks) {
      await sleep(40);
      yield { type: 'text', text: chunk };
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
