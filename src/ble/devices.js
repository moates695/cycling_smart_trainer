import { print, } from '../functions.js';
import ReactiveConnectable from './reactive-connectable.js';
import { webBle, } from './web-ble.js';
import { Device, } from './enums.js';
import { simEnabled, } from '../sim.js';

// In sim mode (?sim=1) the simulated devices in sim.js own the `ble:*` events
// and the connection switches, so the real connectables are not created —
// otherwise clicking a switch would also open the Web Bluetooth chooser.
if(!simEnabled()) {
    const controllable = ReactiveConnectable({
        deviceType: Device.controllable,
        filter: webBle.filters.controllable(),
    });

    const speedCadenceSensor = ReactiveConnectable({
        deviceType: Device.speedCadenceSensor,
        filter: webBle.filters.speedCadenceSensor(),
    });

    const heartRateMonitor = ReactiveConnectable({
        deviceType: Device.heartRateMonitor,
        filter: webBle.filters.heartRateMonitor(),
    });

    const powerMeter = ReactiveConnectable({
        deviceType: Device.powerMeter,
        filter: webBle.filters.powerMeter(),
    });

    const moxy = ReactiveConnectable({
        deviceType: Device.smo2,
        filter: webBle.filters.smo2(),
    });

    const coreTemp = ReactiveConnectable({
        deviceType: Device.coreTemp,
        filter: webBle.filters.coreTemp(),
    });
}

// export {
//     controllabe,
//     heartRateMonitor,
//     powerMeter,
//     speedCadenceSensor,
// };

