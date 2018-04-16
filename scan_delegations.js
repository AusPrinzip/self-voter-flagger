'use strict';

// const steem = require('steem');
const moment = require('moment');
// const S = require('string');
const wait = require('wait.for');
const lib = require('./lib.js');

const API_RETRIES = 10;

function main () {
  // get more information on unhandled promise rejections
  process.on('unhandledRejection', (reason, p) => {
    console.log('Unhandled Rejection at: Promise', p, 'reason:', reason);
    // application specific logging, throwing an error, or other logic here
    process.exit(1);
  });
  lib.start(function () {
    doProcess(lib.getLastInfos().last_delegation_block + 1, function () {
      console.log('Finished');
      setTimeout(function () {
        process.exit();
      }, 5000);
    });
  });
}

function doProcess (startAtBlockNum, callback) {
  wait.launchFiber(function () {
    // set up initial variables
    console.log('Getting blockchain info');
    var headBlock = null;
    var tries = 0;
    while (tries < API_RETRIES) {
      console.log(' - (re)trying to get head block ' + lib.getProperties().head_block_number);
      tries++;
      try {
        headBlock = wait.for(lib.getBlockHeader, lib.getProperties().head_block_number);
        break;
      } catch (err) {
        console.error(err);
        console.log(' - failed to get head block');
      }
    }
    if (headBlock === undefined || headBlock === null) {
      console.log(' - failed to get head block');
      callback();
      return;
    }
    var latestBlockMoment = moment(headBlock.timestamp, moment.ISO_8601);
    // set up vars
    var firstBlockMoment = null;
    var currentBlockNum = startAtBlockNum;
    var endTime = moment(new Date()).add(Number(process.env.MAX_MINS_TO_RUN), 'minute');
    for (var i = startAtBlockNum; i <= lib.getProperties().head_block_number; i++) {
      currentBlockNum = i;
      if (moment(new Date()).isAfter(endTime)) {
        console.log('Max time reached, stopping');
        currentBlockNum--;
        break;
      }
      var block = null;
      tries = 0;
      while (tries < API_RETRIES) {
        console.log(' - (re)trying to get block ' + currentBlockNum);
        tries++;
        try {
          block = wait.for(lib.getBlock, currentBlockNum);
          break;
        } catch (err) {
          console.error(err);
          console.log(' - failed to get block');
        }
      }
      if (block === undefined || block === null) {
        console.log('Getting block failed, finish gracefully');
        finishAndStoreLastInfos(startAtBlockNum, currentBlockNum - 1, function () {
          callback();
        });
        return;
      }
      // create current time moment from block infos
      if (firstBlockMoment === null) {
        firstBlockMoment = latestBlockMoment;
      } else {
        if (firstBlockMoment.dayOfYear() < latestBlockMoment.dayOfYear()) {
          // exit, the have processed entire day
          currentBlockNum--;
          break;
        }
      }
      // console.log("block info: "+JSON.stringify(block));
      var transactions = block.transactions;
      for (var j = 0; j < transactions.length; j++) {
        var transaction = transactions[j];
        for (var k = 0; k < transaction.operations.length; k++) {
          var opName = transaction.operations[k][0];
          var opDetail = transaction.operations[k][1];
          if (opName !== undefined && opName !== null &&
              opName.localeCompare('delegate_vesting_shares') === 0) {
            // keep track of delegations manually
            console.log(' - recording delegation: ' + JSON.stringify(opDetail));
            // first check if zeroed, need to get value from general call
            var vests = Number(opDetail.vesting_shares.replace(' VESTS', ''));
            var sp = 0;
            if (vests > 0) {
              sp = lib.getSteemPowerFromVest(opDetail.vesting_shares);
            } else {
              var accountHistory = null;
              tries = 0;
              while (tries < API_RETRIES) {
                console.log(' - (re)trying to get account history');
                tries++;
                try {
                  accountHistory = wait.for(lib.getSteemAccountHistory, opDetail.delegator, -1, 10000);
                  break;
                } catch (err) {
                  console.error(err);
                  console.log(' - failed to get account history');
                }
              }
              if (accountHistory === undefined || accountHistory === null) {
                console.log(' *** couldnt get account history, exiting');
                finishAndStoreLastInfos(startAtBlockNum, currentBlockNum - 1, function () {
                  callback();
                });
                return;
              }
              var match = false;
              if (accountHistory.length > 0) {
                // console.log(' - DEBUG: ' + JSON.stringify(accountHistory));
                for (var m = 0; m < accountHistory.length; m++) {
                  var operations = accountHistory[m][1]['op'];
                  var accHistOpName = operations[0];
                  var accHistOpDetail = operations[1];
                  if (accHistOpName !== undefined && accHistOpName !== null &&
                      accHistOpName.localeCompare('delegate_vesting_shares') === 0) {
                    // console.log(' - found acc hist delegation: ' + JSON.stringify(accHistOpDetail));
                    if (accHistOpDetail.delegatee.localeCompare(opDetail.delegatee) === 0 &&
                        Number(accHistOpDetail.vesting_shares.replace(' VESTS', '')) > 0) {
                      vests = Number(accHistOpDetail.vesting_shares.replace(' VESTS', '')) * -1;
                      sp = lib.getSteemPowerFromVest(accHistOpDetail.vesting_shares) * -1;
                      console.log(' - - updated delegation amount to negative ' + accHistOpDetail.vesting_shares);
                      match = true;
                      break;
                    }
                  }
                  if (match) {
                    break;
                  }
                }
              }
              if (!match) {
                vests = 0;
                sp = 0;
              }
            }
            // skip if nothing to record
            if (vests === 0) {
              console.log(' - - couldnt update undelegation amount, skipping');
              continue;
            }
            var delegatorInfos = null;
            try {
              delegatorInfos = wait.for(lib.getRecordFromDb, lib.DB_DELEGATIONS, {user: opDetail.delegator});
            } catch (err) {
              // do nothing
            }
            if (delegatorInfos === undefined || delegatorInfos === null) {
              delegatorInfos = {
                user: opDetail.delegator,
                received: [],
                delegated: []
              };
            }
            delegatorInfos.delegated.push(
              {
                user: opDetail.delegatee,
                vests: vests,
                sp: sp,
                timestamp: block.timestamp
              }
            );
            wait.for(lib.saveDb, lib.DB_DELEGATIONS, delegatorInfos);
            var delegateeInfos = null;
            try {
              delegateeInfos = wait.for(lib.getRecordFromDb, lib.DB_DELEGATIONS, {voter: opDetail.delegatee});
            } catch (err) {
              // do nothing
            }
            if (delegateeInfos === undefined || delegateeInfos === null) {
              delegateeInfos = {
                user: opDetail.delegatee,
                received: [],
                delegated: []
              };
            }
            delegateeInfos.received.push(
              {
                user: opDetail.delegator,
                vests: vests,
                sp: sp,
                timestamp: block.timestamp
              }
            );
            wait.for(lib.saveDb, lib.DB_DELEGATIONS, delegateeInfos);
          }
        }
      }
    }
    finishAndStoreLastInfos(startAtBlockNum, currentBlockNum, function () {
      callback();
    });
  });
}

function finishAndStoreLastInfos (startAtBlockNum, currentBlockNum, callback) {
  console.log('Processed from block ' + startAtBlockNum + ' to ' + currentBlockNum);
  var lastInfos = lib.getLastInfos();
  lastInfos.last_delegation_block = currentBlockNum;
  wait.for(lib.saveDb, lib.DB_RECORDS, lastInfos);
  lib.setLastInfos(lastInfos);
  callback();
}

// START THIS SCRIPT
main();
