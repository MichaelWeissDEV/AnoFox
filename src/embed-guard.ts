/**
 * AnoFox Social Embed Guard
 * Protects user privacy by blocking 3rd-party social media embeds (YouTube,
 * Instagram, TikTok, Facebook, X/Twitter, Vimeo, Spotify, Twitch, SoundCloud)
 * before network connections occur, and replaces them with a click-to-load placeholder.
 */

export interface SocialEmbedProviders {
  youtube: boolean;
  instagram: boolean;
  tiktok: boolean;
  facebook: boolean;
  twitter: boolean;
  vimeo: boolean;
  spotify: boolean;
  twitch: boolean;
  soundcloud: boolean;
}

export const DEFAULT_PROVIDERS: SocialEmbedProviders = {
  youtube: true,
  instagram: true,
  tiktok: true,
  facebook: true,
  twitter: true,
  vimeo: true,
  spotify: true,
  twitch: true,
  soundcloud: true
};

export interface EmbedProviderDefinition {
  id: keyof SocialEmbedProviders;
  name: string;
  category: string;
  description: string;
  /** Patterns used for declarativeNetRequest urlFilter */
  dnrFilters: string[];
  /** Substring or regex matchers for URL identification */
  matchUrl: (url: string) => boolean;
  /** CSS selector to identify embed element or iframe in DOM */
  domSelector: string;
  /** Extracts the embed destination URL from an element */
  extractUrl: (element: HTMLElement) => string | null;
  /** Brand color (hex or hsl) */
  brandColor: string;
  /** SVG icon markup */
  iconSvg: string;
}

export const EMBED_ICONS = {
  shield: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`,
  youtube: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.5 12 3.5 12 3.5s-7.505 0-9.377.55a3.016 3.016 0 0 0-2.122 2.136C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.55 9.376.55 9.376.55s7.505 0 9.377-.55a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg>`,
  instagram: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z"/></svg>`,
  tiktok: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.24 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z"/></svg>`,
  facebook: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>`,
  twitter: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>`,
  vimeo: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M23.977 6.416c-.105 2.338-1.739 5.543-4.894 9.609-3.268 4.247-6.026 6.37-8.29 6.37-1.409 0-2.578-1.294-3.553-3.881L5.322 11.4C4.6 8.769 3.834 7.454 3.019 7.454c-.179 0-.806.378-1.881 1.132L0 7.179c1.196-1.045 2.378-2.091 3.543-3.134 1.61-1.391 2.827-2.122 3.652-2.193 1.936-.179 3.129 1.144 3.58 3.968.484 3.028.819 4.939 1.006 5.733.568 2.709 1.189 4.064 1.865 4.064.524 0 1.309-.831 2.355-2.492 1.045-1.662 1.599-2.923 1.662-3.784.104-1.403-.404-2.105-1.527-2.105-.536 0-1.109.123-1.719.369 1.109-3.649 3.227-5.419 6.354-5.311 2.316.077 3.411 1.583 3.284 4.516z"/></svg>`,
  spotify: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"/></svg>`,
  twitch: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M2.149 0L.537 4.119v16.836h5.731V24h3.224l3.045-3.045h4.657l6.269-6.269V0H2.149zm19.164 13.612l-3.582 3.582H12l-3.045 3.045v-3.045H4.119V1.791h17.194v11.821zm-3.582-7.343v6.269h-2.149V6.269h2.149zm-5.731 0v6.269H9.851V6.269h2.15z"/></svg>`,
  soundcloud: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M1.175 12.225c-.051 0-.094.044-.102.102l-.271 2.457.271 2.408c.008.058.051.102.102.102.059 0 .102-.044.11-.102l.305-2.408-.305-2.457c-.008-.058-.051-.102-.11-.102zm-.898 1.169c-.051 0-.093.044-.102.102l-.17 1.288.17 1.288c.009.058.051.102.102.102.059 0 .102-.044.11-.102l.186-1.288-.186-1.288c-.008-.058-.051-.102-.11-.102zm1.796-.839c-.059 0-.102.044-.11.102l-.373 3.288.373 3.237c.008.058.051.102.11.102.051 0 .093-.044.102-.102l.407-3.237-.407-3.288c-.009-.058-.051-.102-.102-.102zm.898-.246c-.059 0-.102.044-.11.102l-.441 3.534.441 3.483c.008.058.051.102.11.102.051 0 .093-.044.102-.102l.475-3.483-.475-3.534c-.009-.058-.051-.102-.102-.102zm.898-.051c-.059 0-.102.044-.11.102l-.508 3.585.508 3.534c.008.058.051.102.11.102.051 0 .093-.044.102-.102l.542-3.534-.542-3.585c-.009-.058-.051-.102-.102-.102zm2.695-1.576c-.068 0-.119.051-.119.119l-.492 5.161.492 5.11c0 .068.051.119.119.119.068 0 .119-.051.119-.119l.525-5.11-.525-5.161c0-.068-.051-.119-.119-.119zm-.898.661c-.059 0-.11.051-.11.11l-.542 4.5.542 4.449c0 .059.051.11.11.11.059 0 .102-.051.11-.11l.576-4.449-.576-4.5c-.008-.059-.051-.11-.11-.11zm-.899.449c-.059 0-.102.051-.11.11l-.525 4.051.525 4c.008.059.051.11.11.11.051 0 .093-.051.102-.11l.559-4-.559-4.051c-.009-.059-.051-.11-.102-.11zm4.491-3.212c-.085 0-.153.068-.153.153l-.407 7.746.407 7.695c0 .085.068.153.153.153.085 0 .153-.068.153-.153l.441-7.695-.441-7.746c0-.085-.068-.153-.153-.153zm-.898 1.119c-.076 0-.136.059-.136.136l-.441 6.627.441 6.576c0 .076.06.136.136.136.076 0 .136-.06.136-.136l.475-6.576-.475-6.627c0-.077-.06-.136-.136-.136zm2.695-1.559c-.102 0-.186.085-.186.186l-.373 9.127.373 9.076c0 .102.084.186.186.186.102 0 .186-.084.186-.186l.407-9.076-.407-9.127c0-.101-.084-.186-.186-.186zm-.898.831c-.093 0-.17.076-.17.17l-.39 8.297.39 8.246c0 .093.077.17.17.17.093 0 .17-.077.17-.17l.424-8.246-.424-8.297c0-.094-.077-.17-.17-.17zm2.695-.39c-.119 0-.22.102-.22.22l-.305 9.492.305 9.441c0 .119.101.22.22.22.119 0 .22-.101.22-.22l.339-9.441-.339-9.492c0-.118-.101-.22-.22-.22zm-.898.542c-.11 0-.203.093-.203.203l-.339 8.949.339 8.898c0 .11.093.203.203.203.11 0 .203-.093.203-.203l.373-8.898-.373-8.949c0-.11-.093-.203-.203-.203zm4.512-.347c-.508 0-.992.119-1.424.331-.229-.025-.466-.042-.712-.042-.322 0-.627.034-.924.093-.136.025-.229.136-.229.271l-.186 9.432.186 9.381c0 .136.093.246.229.271.305.059.619.093.941.093.593 0 1.153-.119 1.661-.339.407.229.873.356 1.373.356 1.771 0 3.212-1.441 3.212-3.212 0-1.771-1.441-3.212-3.212-3.212-.322 0-.627.051-.915.136-.051-2.22-1.856-3.999-4.084-3.999z"/></svg>`
};

export const SUPPORTED_EMBED_PROVIDERS: EmbedProviderDefinition[] = [
  {
    id: 'youtube',
    name: 'YouTube',
    category: 'Video',
    description: 'Blockiert eingebettete YouTube-Videos (youtube.com/embed & youtube-nocookie.com/embed).',
    dnrFilters: [
      '||youtube.com/embed/',
      '||youtube-nocookie.com/embed/'
    ],
    matchUrl: (url: string) => {
      try {
        const u = new URL(url);
        const host = u.hostname.toLowerCase();
        return (host.includes('youtube.com') || host.includes('youtube-nocookie.com')) && u.pathname.includes('/embed/');
      } catch {
        return false;
      }
    },
    domSelector: 'iframe[src*="youtube.com/embed/"], iframe[src*="youtube-nocookie.com/embed/"]',
    extractUrl: (el) => el.getAttribute('src') || el.getAttribute('data-src'),
    brandColor: '#ff0000',
    iconSvg: EMBED_ICONS.youtube
  },
  {
    id: 'instagram',
    name: 'Instagram',
    category: 'Social',
    description: 'Blockiert Instagram-Posts, Reels und das embed.js-Skript.',
    dnrFilters: [
      '||instagram.com/embed.js',
      '||instagram.com/p/*/embed',
      '||instagram.com/reel/*/embed'
    ],
    matchUrl: (url: string) => {
      try {
        const u = new URL(url);
        const host = u.hostname.toLowerCase();
        return host.includes('instagram.com') && (u.pathname.includes('/embed') || u.pathname.includes('/p/') || u.pathname.includes('/reel/'));
      } catch {
        return false;
      }
    },
    domSelector: 'iframe[src*="instagram.com/p/"], iframe[src*="instagram.com/reel/"], iframe[src*="instagram.com/embed"], blockquote.instagram-media',
    extractUrl: (el) => {
      if (el.tagName.toLowerCase() === 'iframe') {
        return el.getAttribute('src') || el.getAttribute('data-src');
      }
      return el.getAttribute('data-instgrm-permalink') || el.querySelector('a')?.getAttribute('href') || null;
    },
    brandColor: '#e1306c',
    iconSvg: EMBED_ICONS.instagram
  },
  {
    id: 'tiktok',
    name: 'TikTok',
    category: 'Video',
    description: 'Blockiert TikTok-Widgets, eingebettete Videos und Tracker.',
    dnrFilters: [
      '||tiktok.com/embed/',
      '||tiktok.com/embed.js',
      '||widgets.tiktok.com/'
    ],
    matchUrl: (url: string) => {
      try {
        const u = new URL(url);
        const host = u.hostname.toLowerCase();
        return host.includes('tiktok.com') && (u.pathname.includes('/embed') || host.includes('widgets.tiktok.com'));
      } catch {
        return false;
      }
    },
    domSelector: 'iframe[src*="tiktok.com/embed"], blockquote.tiktok-embed',
    extractUrl: (el) => {
      if (el.tagName.toLowerCase() === 'iframe') {
        return el.getAttribute('src') || el.getAttribute('data-src');
      }
      return el.getAttribute('cite') || el.querySelector('a')?.getAttribute('href') || null;
    },
    brandColor: '#00f2fe',
    iconSvg: EMBED_ICONS.tiktok
  },
  {
    id: 'facebook',
    name: 'Facebook',
    category: 'Social',
    description: 'Blockiert Facebook-Social-Plugins, Like-Buttons, Comments und connect.facebook.net.',
    dnrFilters: [
      '||facebook.com/plugins/',
      '||connect.facebook.net/'
    ],
    matchUrl: (url: string) => {
      try {
        const u = new URL(url);
        const host = u.hostname.toLowerCase();
        return (host.includes('facebook.com') && u.pathname.includes('/plugins/')) || host.includes('connect.facebook.net');
      } catch {
        return false;
      }
    },
    domSelector: 'iframe[src*="facebook.com/plugins/"], iframe[src*="web.facebook.com/plugins/"], .fb-post, .fb-video, .fb-page, .fb-comments, .fb-like',
    extractUrl: (el) => {
      if (el.tagName.toLowerCase() === 'iframe') {
        return el.getAttribute('src') || el.getAttribute('data-src');
      }
      return el.getAttribute('data-href') || null;
    },
    brandColor: '#1877f2',
    iconSvg: EMBED_ICONS.facebook
  },
  {
    id: 'twitter',
    name: 'X (Twitter)',
    category: 'Social',
    description: 'Blockiert Tweets, Timelines und platform.twitter.com/widgets.js.',
    dnrFilters: [
      '||platform.twitter.com/',
      '||twitter.com/widgets/',
      '||x.com/widgets/'
    ],
    matchUrl: (url: string) => {
      try {
        const u = new URL(url);
        const host = u.hostname.toLowerCase();
        return host.includes('platform.twitter.com') || (host.includes('twitter.com') || host.includes('x.com')) && u.pathname.includes('/widgets');
      } catch {
        return false;
      }
    },
    domSelector: 'iframe[src*="platform.twitter.com"], iframe[src*="twitter.com/widgets"], blockquote.twitter-tweet',
    extractUrl: (el) => {
      if (el.tagName.toLowerCase() === 'iframe') {
        return el.getAttribute('src') || el.getAttribute('data-src');
      }
      return el.querySelector('a')?.getAttribute('href') || null;
    },
    brandColor: '#1d9bf0',
    iconSvg: EMBED_ICONS.twitter
  },
  {
    id: 'vimeo',
    name: 'Vimeo',
    category: 'Video',
    description: 'Blockiert player.vimeo.com Video-Embeds vor der Datenübertragung.',
    dnrFilters: [
      '||player.vimeo.com/video/'
    ],
    matchUrl: (url: string) => {
      try {
        const u = new URL(url);
        return u.hostname.toLowerCase().includes('player.vimeo.com') && u.pathname.includes('/video/');
      } catch {
        return false;
      }
    },
    domSelector: 'iframe[src*="player.vimeo.com/video/"]',
    extractUrl: (el) => el.getAttribute('src') || el.getAttribute('data-src'),
    brandColor: '#1ab7ea',
    iconSvg: EMBED_ICONS.vimeo
  },
  {
    id: 'spotify',
    name: 'Spotify',
    category: 'Audio',
    description: 'Blockiert eingebettete Spotify-Player (open.spotify.com/embed).',
    dnrFilters: [
      '||open.spotify.com/embed/'
    ],
    matchUrl: (url: string) => {
      try {
        const u = new URL(url);
        return u.hostname.toLowerCase().includes('open.spotify.com') && u.pathname.includes('/embed');
      } catch {
        return false;
      }
    },
    domSelector: 'iframe[src*="open.spotify.com/embed"]',
    extractUrl: (el) => el.getAttribute('src') || el.getAttribute('data-src'),
    brandColor: '#1ed760',
    iconSvg: EMBED_ICONS.spotify
  },
  {
    id: 'twitch',
    name: 'Twitch',
    category: 'Live',
    description: 'Blockiert eingebettete Twitch-Streams und Player (player.twitch.tv).',
    dnrFilters: [
      '||player.twitch.tv/'
    ],
    matchUrl: (url: string) => {
      try {
        const u = new URL(url);
        return u.hostname.toLowerCase().includes('player.twitch.tv');
      } catch {
        return false;
      }
    },
    domSelector: 'iframe[src*="player.twitch.tv"]',
    extractUrl: (el) => el.getAttribute('src') || el.getAttribute('data-src'),
    brandColor: '#9146ff',
    iconSvg: EMBED_ICONS.twitch
  },
  {
    id: 'soundcloud',
    name: 'SoundCloud',
    category: 'Audio',
    description: 'Blockiert eingebettete SoundCloud-Player (w.soundcloud.com/player).',
    dnrFilters: [
      '||w.soundcloud.com/player/'
    ],
    matchUrl: (url: string) => {
      try {
        const u = new URL(url);
        return u.hostname.toLowerCase().includes('w.soundcloud.com') && u.pathname.includes('/player');
      } catch {
        return false;
      }
    },
    domSelector: 'iframe[src*="w.soundcloud.com/player"]',
    extractUrl: (el) => el.getAttribute('src') || el.getAttribute('data-src'),
    brandColor: '#ff5500',
    iconSvg: EMBED_ICONS.soundcloud
  }
];

/**
 * Identifies which provider a URL belongs to, or null if it's not a known embed.
 */
export function identifyEmbedProvider(url: string): EmbedProviderDefinition | null {
  if (!url) return null;
  for (const provider of SUPPORTED_EMBED_PROVIDERS) {
    if (provider.matchUrl(url)) {
      return provider;
    }
  }
  return null;
}

/**
 * Checks if a URL matches any embed provider.
 */
export function isEmbedUrl(url: string): boolean {
  return identifyEmbedProvider(url) !== null;
}
