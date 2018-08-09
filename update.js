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
    // get most recent block moment
    var mostRecentBlockNum = lib.getLastInfos().lastBlock;
    if (mostRecentBlockNum === undefined) {
      console.log(' - - last scanned block information not available, exiting');
      callback();
      return;
    }
    var tries = 0;
    var mostRecentBlock;
    while (tries < lib.API_RETRIES) {
      tries++;
      try {
        mostRecentBlock = wait.for(lib.getBlockHeader, mostRecentBlockNum);
        break;
      } catch (err) {
        console.error(err);
        console.log(' - failed to get last processed block ' + mostRecentBlockNum + ', retrying if possible');
      }
    }
    if (mostRecentBlock === undefined || mostRecentBlock === null) {
      console.log(' - completely failed to get last processed block, exiting');
      callback();
      return;
    }
    var mostRecentBlockMoment = moment(mostRecentBlock.timestamp, moment.ISO_8601);
    // get moment to update at or after
    if (lib.getLastInfos().update_time === undefined ||
        lib.getLastInfos().update_time === null) {
      console.log(' - Update time not defined, setting to default of ' + process.env.DAYS_UNTIL_UPDATE + ' days from now');
      lib.getLastInfos().update_time = moment(new Date()).add(Number(process.env.DAYS_UNTIL_UPDATE), 'day').toISOString();
      callback();
      return;
    }
    var updateTimeMoment = moment(lib.getLastInfos().update_time, moment.ISO_8601);
    // check if should update
    console.log(' - most recent block moment: ' + mostRecentBlockMoment.format('dddd, MMMM Do YYYY - HH:mm'));
    console.log(' - time to update moment: ' + updateTimeMoment.format('dddd, MMMM Do YYYY - HH:mm'));
    console.log(' - - is update moment before most recent block moment?');
    if (updateTimeMoment.isBefore(mostRecentBlockMoment)) {
      // DO UPDATE
      // get queue
      var queue = wait.for(lib.getAllRecordsFromDb, lib.DB_QUEUE);
      if (queue === undefined || queue === null || queue.length === 0) {
        console.log(' - - nothing in queue! Exiting');
        callback();
        return;
      }
      // apply final score adjustment based on entire period stats
      console.log(' - adjusting scores based on weekly stats for outgoing votes...');
      for (var i = 0; i < queue.length; i++) {
        queue[i].outgoing_adjust_total = Math.min((queue[i].outgoing_voter_list_count === 0 ? 0
          : (queue[i].outgoing_voter_list_count / queue[i].self_vote_weight_sum) * queue[i].outgoing_voter_list_weight_sum) * 70,
          45);
        queue[i].old_score = queue[i].score;
        queue[i].score -= queue[i].outgoing_adjust_total;
      }
      // save queue to flaglist
      console.log(' - sorting flag list...');
      queue.sort(function (a, b) {
        return b.score - a.score;
      });
      wait.for(lib.dropDb, lib.DB_FLAGLIST);
      for (i = 0; i < queue.length; i++) {
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
      // drop voters and queue info, start fresh
      try {
        wait.for(lib.dropDb, lib.DB_VOTERS);
      } catch (err) {
        console.log('Couldnt drop voters DB');
      }
      try {
        wait.for(lib.dropDb, lib.DB_QUEUE);
      } catch (err) {
        console.log('Couldnt drop queue DB');
      }
    } else {
      console.log(' - - not updating flag list, not time to update yet');
    }
    callback();
  });
}

// START THIS SCRIPT
main();
