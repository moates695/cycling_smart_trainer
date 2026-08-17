
class Config {
    #defaultStravaClientId = 0;
    #defaultTrainingPeaksClientId = 0;

    constructor() {
        this.env = {
            // PWA_URI: "http://localhost:1234",
            // API_URI: "http://localhost:8080",
            PWA_URI: window.location.origin ?? "https://auuki.com",
            // Upstream Auuki's backend. Its CORS allowlist contains exactly one
            // origin (https://auuki.com), so every call from this fork — local or
            // deployed — is blocked by the browser. Kept only so the Strava and
            // TrainingPeaks models still import cleanly; nothing here can succeed.
            API_URI: "https://api.auuki.com",
            // The WATTS accounts and sync backend. Same origin in both
            // environments — nginx proxies /api/ in production, and Parcel's
            // .proxyrc does the same in development — so the session cookie is
            // first party and no CORS preflight is involved.
            WATTS_API_URI: "/api",
            STRAVA_CLIENT_ID: this.defaultStravaClientId,
            TRAINING_PEAKS_CLIENT_ID: this.defaultTrainingPeaksClientId,
        };
    }
    setServices(args = {}) {
        this.env.STRAVA_CLIENT_ID = args.strava ?? this.defaultStravaClientId;
        this.env.TRAINING_PEAKS_CLIENT_ID = args.trainingPeaks ?? this.defaultTrainingPeaksClientId;
    }
    get() {
        return this.env;
    }
}

const config = new Config();

export default config;
