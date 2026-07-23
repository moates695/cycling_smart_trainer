import { xf, formatDate, } from '../functions.js';
import { models } from '../models/models.js';
import { formatTime, } from '../utils.js';

// how many activities to reveal per page (initial view and each "Load more").
const ACTIVITY_PAGE = 5;

class ActivityList extends HTMLElement {
    constructor() {
        super();
        this.activities = [];
        this.shown = ACTIVITY_PAGE;
    }
    connectedCallback() {
        const self = this;
        this.abortController = new AbortController();
        this.signal = { signal: self.abortController.signal };

        xf.sub('activity:add', self.onAdd.bind(this), this.signal);
        xf.sub('db:activity', self.onRestore.bind(this), this.signal);
        this.addEventListener('pointerup', self.onClick.bind(this), this.signal);
    }
    disconnectedCallback() {
        this.abortController.abort();
    }
    onClick(e) {
        if(e.target.closest('.activity--load-more')) {
            this.shown += ACTIVITY_PAGE;
            this.renderList();
        }
    }
    onAdd(activity) {
        // newest first, and make sure the just-finished ride is visible
        this.activities.unshift(activity);
        this.shown += 1;
        this.renderList();
        xf.dispatch(`action:activity:${this.id(activity)}`, ':toggleExpand');
    }
    onRestore(activities) {
        this.activities = [...(activities ?? [])]
            .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
        this.shown = ACTIVITY_PAGE;
        this.renderList();
    }
    renderList() {
        const shown = Math.min(this.shown, this.activities.length);
        const rows = this.activities
            .slice(0, shown)
            .map((a, i) => this.template(i, a))
            .join('');
        const remaining = this.activities.length - shown;
        const more = remaining > 0
            ? `<button class="activity--load-more">Load more (${remaining})</button>`
            : '';
        this.innerHTML = rows + more;
    }
    id(data) {
        return data.id;
    }
    name(data) {
        return data.name;
    }
    date(data) {
        return formatDate({
            date: new Date(data.timestamp),
            separator: '/',
            year: false,
        });
    }
    duration(data) {
        return `${Math.ceil(data.duration / 60)} min`;
    }
    template(i, data) {
        return `
            <activity-item id="i${i}--activity--item" class="some" data-id="${this.id(data)}">
                    <div class="activity--cont list--row--outer">
                        <div class="list--row--inner activity--info">
                            <div class="activity--info--short">
                                <view-action
                                    class="info"
                                    action=":toggleExpand"
                                    topic=":activity:${this.id(data)}">
                                    <div id="i${i}--activity--date" class="activity--name">
                                        ${this.name(data)}
                                    </div>
                                    <div class="activity--date">
                                        ${this.date(data)}
                                    </div>
                                    <div id="i${i}--activity--duration" class="activity--duration">
                                        ${this.duration(data)}
                                    </div>
                                </view-action>
                                <view-action
                                    class=""
                                    action=":options"
                                    topic=":activity:${this.id(data)}">
                                    <svg class="control--btn--icon" width="24" height="24">
                                        <use href="#icon--options" />
                                    </svg>
                                </view-action>
                            </div>
                            <div class="activity--info--full">
                                <div class="activity--image">
                                </div>
                                <div class="activity--actions">
                                    <div></div>
                                    <view-action
                                        class="activity--action action--download"
                                        action=":download"
                                        topic=":activity:${this.id(data)}">
                                        <svg class="activity--icon">
                                            <use href="#icon--save-btn" />
                                        </svg>
                                    </view-action>
                                    <view-action
                                        class="activity--action action--image"
                                        action=":image"
                                        topic=":activity:${this.id(data)}">
                                        <svg class="activity--icon">
                                            <use href="#icon--image" />
                                        </svg>
                                    </view-action>
                                </div> <!-- end activity--actions -->
                            </div> <!-- end activity--info--full -->
                        </div> <!-- end activity--info -->
                    </div> <!-- end activity--cont -->
                    <view-action
                        class="activity--options"
                        action=":remove"
                        topic=":activity:${this.id(data)}">
                        <span class="activity--remove">Delete</span>
                    </view-action>
            </activity-item>
        `;
    }
}

customElements.define('activity-list', ActivityList);

class ActivityItem extends HTMLElement {
    constructor() {
        super();
    }
    connectedCallback() {
        const self = this;
        this.abortController = new AbortController();
        this.signal = { signal: self.abortController.signal };

        this.id = this.dataset.id;

        xf.sub(`action:activity:${self.id}`, this.onAction.bind(this), this.signal);
    }
    disconnectedCallback() {
        this.abortController.abort();
    }
    onAction(action) {
        console.log(action, this.id);

        if(action === ':options') {
            this.classList.toggle('options');
            return;
        }
        if(action === ':toggleExpand') {
            this.classList.toggle('expand');
            return;
        }
        if(action === ':remove') {
            // TODO: refactor to a functional state driven approach
            models.activity.remove(this.id);
            this.remove();
            return;
        }

        if(action === ':download') {
            models.activity.download(this.id);
            return;
        }
    }
}

customElements.define('activity-item', ActivityItem);
