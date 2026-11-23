import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIVE_TV_CHANNELS, TV_STORAGE_KEY, channelByName, embedUrl, rememberChannel, rememberedChannel, renderTvSection } from '../site/tv.js';

test('channel order: NBC and Bloomberg first, five official channels', () => {
  assert.deepEqual(
    LIVE_TV_CHANNELS.map((c) => c.name),
    ['NBC News NOW', 'Bloomberg Television', 'Al Jazeera English', 'DW News', 'France 24 English']
  );
  assert.ok(LIVE_TV_CHANNELS.every((c) => /^UC[\w-]{22}$/.test(c.channelId)));
});

test('embed URLs are official YouTube embeds, muted, nothing else', () => {
  const u = embedUrl(LIVE_TV_CHANNELS[0]);
  assert.ok(u.startsWith('https://www.youtube.com/embed/live_stream?channel=UCeY0bbntWzzVIaj2z3QigXg&'));
  assert.ok(u.includes('mute=1'));
  assert.equal(embedUrl({ videoId: 'abc123' }), 'https://www.youtube.com/embed/abc123?autoplay=1&mute=1&rel=0');
});

test('last-picked channel is remembered per device and tolerates missing storage', () => {
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  assert.equal(rememberedChannel(storage), null);
  rememberChannel(channelByName('DW News'), storage);
  assert.equal(store.get(TV_STORAGE_KEY), 'DW News');
  assert.equal(rememberedChannel(storage).name, 'DW News');
  assert.equal(rememberedChannel({ getItem: () => 'Not A Channel' }), null, 'unknown names are ignored');
  assert.equal(rememberedChannel(undefined), null);
  assert.doesNotThrow(() => rememberChannel(LIVE_TV_CHANNELS[0], { setItem: () => { throw new Error('blocked'); } }));
});

test('the section renders collapsed with no iframe and no YouTube URL until a tap', () => {
  const html = renderTvSection();
  assert.ok(html.startsWith('<details class="section tv"'), 'collapsed by default (no open attribute)');
  assert.ok(!html.includes('<iframe'));
  assert.ok(!html.includes('youtube.com'));
  assert.ok(html.includes('OFF · TAP A CHANNEL TO START'));
  for (const c of LIVE_TV_CHANNELS) assert.ok(html.includes(`data-tv-channel="${c.name}"`));
});
