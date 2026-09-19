import { Module } from '@nestjs/common';
import { SerperWebSearchProvider } from './serper.provider';
import { WebSearchService } from './websearch.service';

/**
 * Opt-in web search (Serper for the MVP behind the provider abstraction).
 * Imported by MessagesModule only — nothing else touches search directly,
 * so a future provider swap stays inside this module.
 */
@Module({
  providers: [SerperWebSearchProvider, WebSearchService],
  exports: [WebSearchService],
})
export class WebsearchModule {}
