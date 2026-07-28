var interval;
var period = 1000;

function onStart() {
    onStop();
    interval = setInterval(function(){
        self.postMessage('tick');
    }, period);
}

function onStop() {
    clearInterval(interval);
    interval = undefined;
}

// Fast forward, for the device sim only. A rate of 2 makes every tick half a
// real second long, so a workout second passes twice as fast. Restarts the
// interval at the new period if the clock is already running.
function onRate(rate) {
    var value = (typeof rate === 'number' && rate > 0) ? rate : 1;
    period = 1000 / value;
    if(interval !== undefined) onStart();
}

self.addEventListener('message', function(e) {
    var data = e.data;

    if(data !== null && typeof data === 'object') {
        if(data.cmd === 'rate') onRate(data.rate);
        return;
    }

    switch (data) {
    case 'start': onStart(); break;
    case 'stop':  onStop(); break;
    case 'pause': onStop(); break;
    };
}, false);
