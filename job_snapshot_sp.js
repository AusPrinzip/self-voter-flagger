'use strict';

const wait = require('wait.for');
const lib = require('./lib.js');

function main () {
  console.log(' *** JOB_SNAPSHOT_SP.js');
  // get more information on unhandled promise rejections
  process.on('unhandledRejection', (reason, p) => {
    console.log('Unhandled Rejection at: Promise', p, 'reason:', reason);
    // application specific logging, throwing an error, or other logic here
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

var users = [];

function doProcess (callback) {
  wait.launchFiber(function () {
    console.log(' - fetching all users from db');
    var keepGoing = true;
    var cursor = lib.getDbCursor(lib.DB_DELEGATIONS, 100);
    while (keepGoing) {
      try {
        users = wait.for(cursor.toArray);
        if (users === undefined || users === null) {
          users = [];
        }
      } catch (err) {
        console.error(err);
        callback();
        keepGoing = false;
        return;
      }
      console.log(' - got ' + users.length + ' user info');
      if (users.length === 0) {
        console.log(' - - no more users to process in DB');
        callback();
        keepGoing = false;
        return;
      }
      for (var i = 0; i < users.length; i++) {
        var userInfos = users[i];
        /*
        try {
          userInfos = wait.for(lib.getRecordFromDb, lib.DB_DELEGATIONS, {user: users[i]});
        } catch (err) {
          console.error(err);
          console.log(' - failed to delegation info for ' + users[i]);
          continue;
        }
        */
        var accounts = null;
        var tries = 0;
        while (tries < lib.API_RETRIES) {
          tries++;
          try {
            accounts = wait.for(lib.getSteemAccounts, userInfos.user);
            break;
          } catch (err) {
            console.error(err);
            console.log(' - failed to get account for ' + userInfos.user + ', retrying if possible');
          }
        }
        if (accounts === undefined || accounts === null) {
          console.log(' - completely failed to get account, skipping');
          return;
        }
        var account = accounts[0];
        try {
          var steemPower = lib.getSteemPowerFromVest(account.vesting_shares) +
              lib.getSteemPowerFromVest(account.received_vesting_shares) -
              lib.getSteemPowerFromVest(account.delegated_vesting_shares);
        } catch (err) {
          console.log(' - couldnt calc vesting shares to SP for user ' + userInfos.user + ', skipping');
          return;
        }
        console.log(' - ' + userInfos.user + ' sp = ' + steemPower);
        userInfos.sp = steemPower;
        try {
          wait.for(lib.saveDb, lib.DB_DELEGATIONS, userInfos);
        } catch (err) {
          console.log(' - - couldnt save user infos for ' + userInfos.user);
          console.error(err);
        }
      }
      console.log('finished processing user list');
    }
  });
}

// START THIS SCRIPT
main();
