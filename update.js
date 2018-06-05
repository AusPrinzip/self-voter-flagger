'use strict';

const moment = require('moment');
const wait = require('wait.for');
const lib = require('./lib.js');

function main () {
  console.log(' *** UPDATE.js');
  lib.start(function () {
    process.on('unhandledRejection', (reason, p) => {
      console.log('Unhandled Rejection at: Promise', p, 'reason:', reason);
      process.exit(1);
    });
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
    var mostRecentBlockNum = lib.getLastInfos().lastBlock;
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
      console.log(' - Update time not defined, setting to default of ' + process.env.DAYS_UNTIL_UPDATE + ' days from now');
      lib.getLastInfos().update_time = moment(new Date()).add(Number(process.env.DAYS_UNTIL_UPDATE), 'day').toISOString();
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
        return b.score - a.score;
      });
      wait.for(lib.dropDb, lib.DB_FLAGLIST);
      for (var i = 0; i < queue.length; i++) {
        queue.posts = [];
        wait.for(lib.saveDb, lib.DB_FLAGLIST, queue[i]);
      }
      // make new update time
      var oldUpdateTime = lib.getLastInfos().update_time;
      lib.getLastInfos().update_time = moment(new Date()).add(Number(process.env.DAYS_UNTIL_UPDATE), 'day').toISOString();
      wait.for(lib.saveDb, lib.DB_RECORDS, lib.getLastInfos());
      wait.for(lib.saveDb, lib.DB_UPDATES,
        {
          old_update_time: oldUpdateTime,
          new_update_time: lib.getLastInfos().update_time,
          time_now: moment(new Date()).toISOString(),
          last_block: lib.getLastInfos().lastBlock
        });
      // drop voters info, start fresh
      try {
        wait.for(lib.dropDb, lib.DB_VOTERS);
      } catch (err) {
        console.log('Couldnt drop voters DB');
      }
    } else {
      console.log(' - - not updating flag list, not time to update yet');
    }
    callback();
  });
}

// START THIS SCRIPT
main();
