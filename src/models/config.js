
class Config {
    #defaultStravaClientId = 0;
    #defaultIntervalsClientId = 0;
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
            // Intervals.icu reflects arbitrary origins in its CORS headers and
            // accepts HTTP Basic auth with a personal API key, so this fork talks
            // to it straight from the browser and needs no backend of its own.
            INTERVALS_API_URI: "https://intervals.icu/api/v1",
            STRAVA_CLIENT_ID: this.defaultStravaClientId,
            INTERVALS_CLIENT_ID: this.defaultIntervalsClientId,
            TRAINING_PEAKS_CLIENT_ID: this.defaultTrainingPeaksClientId,
        };
    }
    setServices(args = {}) {
        this.env.STRAVA_CLIENT_ID = args.strava ?? this.defaultStravaClientId;
        this.env.INTERVALS_CLIENT_ID = args.intervals ?? this.defaultIntervalsClientId;
        this.env.TRAINING_PEAKS_CLIENT_ID = args.trainingPeaks ?? this.defaultTrainingPeaksClientId;
    }
    get() {
        return this.env;
    }
}

const config = new Config();

export default config;
