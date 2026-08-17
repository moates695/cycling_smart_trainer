// Workout category labels — the enumerable set of names every workout carries
// on `meta.category` (e.g. "VO2 Max", "Recovery").
//
// This is the single source of truth for those labels. The designer's category
// picker, the Home category chip colour, and the workout-type check in watch.js
// all read from here instead of hard-coding the strings.
//
// Note: categories arriving from external sources (imported .ZWO files,
// Intervals.icu) may still carry arbitrary strings, so lookups against the
// colour map below should fall back gracefully rather than assume membership.

// The canonical, enumerable category names. Keys are code-friendly; values are
// the display strings stored on `meta.category` and shown in the UI.
export const WorkoutCategory = Object.freeze({
    base:      'Base',
    recovery:  'Recovery',
    sweetSpot: 'Sweet Spot',
    threshold: 'Threshold',
    vo2Max:    'VO2 Max',
    hiit:      'HIIT',
    test:      'Test',
    custom:    'Custom',
});

// Ordered list of the display names — used to build the designer's <select>.
export const workoutCategories = Object.values(WorkoutCategory);

// The category new workouts start on.
export const DEFAULT_WORKOUT_CATEGORY = WorkoutCategory.sweetSpot;

// Category → accent colour (roughly zone-aligned), used by the Home category
// chip. Includes a few legacy/alias names (VO2, Tempo, Endurance, Anaerobic) so
// workouts imported with those labels still colour sensibly.
export const workoutCategoryColor = Object.freeze({
    [WorkoutCategory.vo2Max]:    '#f97316',
    'VO2':                       '#f97316',
    [WorkoutCategory.hiit]:      '#ef4444',
    'Anaerobic':                 '#ef4444',
    [WorkoutCategory.threshold]: '#eab308',
    [WorkoutCategory.sweetSpot]: '#22c55e',
    'Tempo':                     '#22c55e',
    [WorkoutCategory.base]:      '#3d8bfd',
    'Endurance':                 '#3d8bfd',
    // Recovery is Z1, whose zone colour (#3b4250) is a near-black slate — fine as
    // a graph fill, unreadable as label text on the dark UI. White instead.
    [WorkoutCategory.recovery]:  '#ffffff',
});

// Fallback accent for categories not in the map above.
export const WORKOUT_CATEGORY_FALLBACK_COLOR = '#8b93a3';
