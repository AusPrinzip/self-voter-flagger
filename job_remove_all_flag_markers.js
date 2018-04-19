'use strict';

const wait = require('wait.for');
const lib = require('./lib.js');

function main () {
  console.log(' *** JOB_REMOVE_ALL_FLAG_MARKERS.js');
  process.on('unhandledRejection', (reason, p) => {
    console.log('Unhandled Rejection at: Promise', p, 'reason:', reason);
    process.exit(1);
  });
  lib.start(function () {
    doProcess(function () {
      console.log('Finished');
      setTimeout(function () {
        process.exit();
      }, 5000);
    });
  });
}

var flaglist = [];

function doProcess (callback) {
  wait.launchFiber(function () {
    // get flaglist
    console.log('getting flaglist...');
    try {
      flaglist = wait.for(lib.getAllRecordsFromDb, lib.DB_FLAGLIST);
      if (flaglist === undefined || flaglist === null) {
        console.log('cant get flaglist, exiting');
        callback();
        return;
      }
    } catch (err) {
      console.error(err);
      console.log('cant get flaglist, exiting');
      callback();
      return;
    }
    if (flaglist.length === 0) {
      console.log('flaglist is empty, ending task');
      callback();
      return;
    }
    var finish = false;
    for (var i = 0; i < flaglist.length; i++) {
      var voterDetails = flaglist[i];
      console.log(' - voter: ' + voterDetails.voter + ' has ' + voterDetails.posts.length + ' recorded posts');

      for (var j = 0; j < voterDetails.posts.length; j++) {
        var postDetails = voterDetails.posts[j];

        if (postDetails.flagged !== undefined &&
            postDetails.flagged !== null &&
            postDetails.flagged) {
          postDetails.flagged = false;
        }
      }
      // save updated voter object to flaglist
      wait.for(lib.saveDb, lib.DB_FLAGLIST, flaglist[i]);
      // update on queue if still on queue
      try {
        var queueObj = wait.for(lib.getRecordFromDb, lib.DB_QUEUE, {voter: flaglist[i].voter});
        if (queueObj !== undefined && queueObj !== null) {
          queueObj.posts = flaglist[i].posts;
          wait.for(lib.saveDb, lib.DB_QUEUE, queueObj);
          console.log(' -* saved update obj to queue');
        }
      } catch (err) {
        // nothing
      }
      // update on master voter list
      try {
        var masterVoterObj = wait.for(lib.getRecordFromDb, lib.DB_VOTERS, {voter: flaglist[i].voter});
        if (masterVoterObj !== undefined && masterVoterObj !== null) {
          masterVoterObj.posts = flaglist[i].posts;
          wait.for(lib.saveDb, lib.DB_VOTERS, masterVoterObj);
          console.log(' -* saved update obj to master voter list');
        }
      } catch (err) {
        // nothing
      }
      // finish early if required
      if (finish) {
        break;
      }
    }
    callback();
  });
}

// START THIS SCRIPT
main();
