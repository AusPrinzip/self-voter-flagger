'use strict';

const moment = require('moment');
const wait = require('wait.for');
const lib = require('./lib.js');

function main () {
  console.log(' *** UPDATE.js');
  lib.start(function () {
    if (!lib.getLastInfos().blocked || lib.getLastInfos().do_update_queue) {
      console.log(' --- delegation script not finished (blocked) yet, or bot not finished scanning, do not process update script until up to date');
      setTimeout(function () {
        process.exit();
      }, 5000);
      return;
    }
    doProcess(function () {
      console.log('Finished');
      setTimeout(function () {
        process.exit();
      }, 5000);
    });
  });
}

function doProcess (callback) {
  wait.launchFiber(function () {
    var mostRecentBlockNum = lib.getLastInfos().last_delegation_block;
    if (mostRecentBlockNum === undefined) {
      console.log(' - - last scanned block information not available, exiting');
      callback();
      return;
    }

    var headBlock = null;
    var tries = 0;
    while (tries < lib.API_RETRIES) {
      tries++;
      try {
        headBlock = wait.for(lib.getBlockHeader, lib.getProperties().head_block_number);
        break;
      } catch (err) {
        console.error(err);
        console.log(' - failed to get head block ' + lib.getProperties().head_block_number + ', retrying if possible');
      }
    }
    if (headBlock === undefined || headBlock === null) {
      console.log(' - completely failed to get head block, exiting');
      callback();
      return;
    }
    var latestBlockMoment = moment(headBlock.timestamp, moment.ISO_8601);
    if (lib.getLastInfos().update_time === undefined ||
        lib.getLastInfos().update_time === null) {
      console.log(' - Update time not defined, dont know when to update, fix by running scrape_and_queue.js');
      callback();
      return;
    }
    var updateTimeMoment = moment(lib.getLastInfos().update_time, moment.ISO_8601);

    if (updateTimeMoment.isBefore(latestBlockMoment)) {
      console.log(' - updating flag list from queue...');
      // update
      var queue = wait.for(lib.getAllRecordsFromDb, lib.DB_QUEUE);
      if (queue === undefined || queue === null || queue.length === 0) {
        console.log(' - - nothing in queue! Exiting');
        callback();
        return;
      }
      queue.sort(function (a, b) {
        return b.total_extrapolated_roi - a.total_extrapolated_roi;
      });
      wait.for(lib.dropDb, lib.DB_FLAGLIST);
      for (var i = 0; i < queue.length; i++) {
        wait.for(lib.saveDb, lib.DB_FLAGLIST, queue[i]);
      }
      // make new update time
      lib.getLastInfos().update_time = moment(new Date()).add(Number(process.env.DAYS_UNTIL_UPDATE), 'day').toISOString();
      lib.getLastInfos().do_update_queue = false;
      wait.for(lib.saveDb, lib.DB_RECORDS, lib.getLastInfos());
    } else {
      console.log(' - - not updating flag list, not time to update yet');
    }
    callback();
  });
}

// START THIS SCRIPT
main();
