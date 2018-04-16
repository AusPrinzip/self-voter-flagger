'use strict';

const wait = require('wait.for');
const lib = require('./lib.js');

function main () {
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

function doProcess (callback) {
  // iterate through delegated accounts, adding current SP to each
  lib.getDbCursor(lib.DB_DELEGATIONS).count(function (err, count) {
    if (err) {
      console.error(err);
      callback();
      return;
    }
    var recordsCount = count;
    lib.getDbCursor(lib.DB_DELEGATIONS).forEach(function (userInfos) {
      if (userInfos === null) {
        console.log('finished processing user list');
        callback();
        return;
      }
      wait.launchFiber(function () {
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
          console.log(' - couldny calc vesting shares to SP for user ' + userInfos.user + ', skipping');
          return;
        }
        userInfos.sp = steemPower;
        try {
          wait.for(lib.saveDb, lib.DB_DELEGATIONS, userInfos);
        } catch (err) {
          console.log(' - - couldnt save user infos for ' + userInfos.user);
        }
        if (--recordsCount <= 0) {
          // done
          console.log('finished processing user list');
          callback();
        }
      });
    }, function (err) {
      if (err) {
        console.error(err);
        callback();
      }
    });
  });
}

// START THIS SCRIPT
main();
