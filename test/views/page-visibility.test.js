/**
 * Guards the page/sub-tab visibility contract in the stylesheets.
 *
 * Navigation is class-driven: <page-group> puts `.active` on exactly one
 * `.page` and flux.css hides the rest. Per-page layout, though, is written at
 * id specificity (`#home-page.page { ... }`, `#workouts-page { ... }`), so a
 * `display` declaration landing in one of those blocks outranks the hide rule
 * and the page renders stacked below Home instead of replacing it. That
 * regression has been reintroduced more than once, hence these tests.
 *
 * Two things are asserted:
 *   1. the hide rules are unbeatable (`:not(.active)` + `!important`);
 *   2. no rule sets `display` on a page/sub-tab shell in its inactive state.
 */

const fs = require('fs');
const path = require('path');

const cssDir = path.join(__dirname, '..', '..', 'src', 'css');
const cssFiles = fs.readdirSync(cssDir).filter((f) => f.endsWith('.css'));

// selector -> declaration block, for top-level rules. Nested blocks (flux.css
// uses native CSS nesting in places) are skipped by the brace matching below,
// which is fine: the shells we care about are all styled at the top level.
function rules(css) {
    const out = [];
    // strip comments so a commented-out rule can't trip the test
    const source = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const re = /([^{}]+)\{([^{}]*)\}/g;
    let match;
    while((match = re.exec(source)) !== null) {
        out.push({selector: match[1].trim(), body: match[2]});
    }
    return out;
}

const allRules = cssFiles.flatMap((file) =>
    rules(fs.readFileSync(path.join(cssDir, file), 'utf8'))
        .map((rule) => ({...rule, file})));

// a compound selector that targets a page/sub-tab shell itself (not one of its
// descendants): the last thing in the selector is the shell.
const shellSelector =
    /(^|[\s>+~,])(#(home|workouts|settings)-page|\.page|\.sub-tab|#view--[\w-]+)((\.|:)[\w.:()-]+)?$/;

function declaresDisplay(body) {
    return /(^|[;{])\s*display\s*:/.test(body);
}

function targetsActive(selector) {
    return selector.includes('.active');
}

describe('page visibility contract', () => {
    test('inactive pages are hidden with an unbeatable rule', () => {
        const rule = allRules.find((r) => r.selector === '.page:not(.active)');
        expect(rule).toBeDefined();
        expect(rule.body.replace(/\s+/g, ' ')).toContain('display: none !important');
    });

    test('inactive sub-tabs are hidden with an unbeatable rule', () => {
        const rule = allRules.find((r) => r.selector === '.sub-tab:not(.active)');
        expect(rule).toBeDefined();
        expect(rule.body.replace(/\s+/g, ' ')).toContain('display: none !important');
    });

    test('no rule sets display on a page shell outside its active state', () => {
        const offenders = allRules
            .filter((r) => declaresDisplay(r.body))
            .filter((r) => r.selector.split(',').some((s) => shellSelector.test(s.trim())))
            .filter((r) => !targetsActive(r.selector))
            // the two canonical hide rules above are the intended exception
            .filter((r) => !/:not\(\.active\)/.test(r.selector))
            .map((r) => `${r.file}: ${r.selector}`);

        // A `display` here beats `.page { display: none }` on specificity and
        // makes every page render at once. Move it onto the `.active` rule.
        expect(offenders).toEqual([]);
    });
});
