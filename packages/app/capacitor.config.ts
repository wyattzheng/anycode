import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
    appId: 'io.anycoder.app',
    appName: 'AnyCode',
    webDir: 'dist',
    server: {
        // Allow mixed content (http/https) for dev servers
        androidScheme: 'https',
        iosScheme: 'capacitor',
    },
};

export default config;
