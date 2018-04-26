'use strict';

// const steem = require('steem');
const moment = require('moment');
// const S = require('string');
const wait = require('wait.for');
const lib = require('./lib.js');

function main () {
  console.log(' *** BOT.js');
  process.on('unhandledRejection', (reason, p) => {
    console.log('Unhandled Rejection at: Promise', p, 'reason:', reason);
    process.exit(1);
  });
  lib.start(function () {
    if (!lib.getLastInfos().blocked) {
      console.log(' --- delegation script not finished (blocked) yet, do not process main bot algo until up to date');
      setTimeout(function () {
        process.exit();
      }, 5000);
      return;
    }
    doProcess(lib.getLastInfos().lastBlock + 1, function () {
      checkFinished(function () {
        console.log('Finished');
        setTimeout(function () {
          process.exit();
        }, 5000);
      });
    });
  });
}

var queue = [];

function doProcess (startAtBlockNum, callback) {
  wait.launchFiber(function () {
    // set up initial variables
    console.log('Getting blockchain info');
    var maxBlockNum = lib.getProperties().head_block_number;
    if (lib.getLastInfos().last_delegation_block !== undefined) {
      if (maxBlockNum > lib.getLastInfos().last_delegation_block) {
        maxBlockNum = lib.getLastInfos().last_delegation_block;
      }
    } else {
      console.log(' * delegation information not available, run delegation script before bot script');
      callback();
      return;
    }
    if (startAtBlockNum >= maxBlockNum) {
      console.log(' - no blocks to run, have reached current max at ' + maxBlockNum);
      callback();
      return;
    }
    var priceInfo = null;
    var tries = 0;
    while (tries < lib.API_RETRIES) {
      tries++;
      try {
        priceInfo = wait.for(lib.getCurrentMedianHistoryPrice);
        break;
      } catch (err) {
        console.error(err);
        console.log(' - failed to get price info, retrying if possible');
      }
    }
    if (priceInfo === undefined || priceInfo === null) {
      console.log(' - completely failed to get price info, exiting');
      callback();
      return;
    }
    console.log('Price info: ' + JSON.stringify(priceInfo));
    var sbdPerSteem = priceInfo.base.replace(' SBD', '') / priceInfo.quote.replace(' STEEM', '');

    // get queue
    console.log('getting queue...');
    try {
      queue = wait.for(lib.getAllRecordsFromDb, lib.DB_QUEUE);
      if (queue === undefined || queue === null) {
        queue = [];
      }
    } catch (err) {
      queue = [];
    }
    // set up vars
    var currentBlockNum = startAtBlockNum;
    var endTime = moment(new Date()).add(Number(process.env.MAX_MINS_TO_RUN), 'minute');
    console.log(' - processing block ' + startAtBlockNum + ' to block ' + maxBlockNum + ', as far as possible');
    for (var i = startAtBlockNum; i <= maxBlockNum; i++) {
      currentBlockNum = i;
      if (moment(new Date()).isAfter(endTime)) {
        console.log('Max time reached, stopping');
        currentBlockNum--;
        break;
      }
      var block = null;
      tries = 0;
      while (tries < lib.API_RETRIES) {
        tries++;
        try {
          block = wait.for(lib.getBlock, currentBlockNum);
          break;
        } catch (err) {
          console.error(err);
          console.log(' - failed to get block ' + currentBlockNum + ', retrying if possible');
        }
      }
      if (block === undefined || block === null) {
        console.log(' - completely failed to get block, exiting');
        finishAndStoreLastInfos(startAtBlockNum, currentBlockNum - 1, function () {
          callback();
        });
        return;
      }
      // create current time moment from block infos
      var thisBlockMoment = moment(block.timestamp, moment.ISO_8601);
      // console.log("block info: "+JSON.stringify(block));
      var transactions = block.transactions;
      for (var j = 0; j < transactions.length; j++) {
        var transaction = transactions[j];
        for (var k = 0; k < transaction.operations.length; k++) {
          var opName = transaction.operations[k][0];
          var opDetail = transaction.operations[k][1];
          if (opName !== undefined && opName !== null &&
            opName.localeCompare('vote') === 0) {
            // process all posts, not just comments
            /*
            var permlinkParts = opDetail.permlink.split("-");
            if (permlinkParts.length === 0
              || !S(permlinkParts[0]).startsWith("re")
              || !S(permlinkParts[permlinkParts.length - 1]).startsWith("201")
              || !S(permlinkParts[permlinkParts.length - 1]).endsWith("z")
              || permlinkParts[permlinkParts.length - 1].indexOf("t") < 0) {
              //console.log("Not a comment, skipping");
              continue;
            }
            */

            // try to get voter info from db
            var voterInfos = wait.for(lib.getRecordFromDb, lib.DB_VOTERS, {voter: opDetail.voter});

            // THEN, check vote is a self vote
            if (opDetail.voter.localeCompare(opDetail.author) !== 0) {
              continue;
            }

            // get post content and rshares of vote
            var content = null;
            tries = 0;
            while (tries < lib.API_RETRIES) {
              tries++;
              try {
                content = wait.for(lib.getPostContent, opDetail.author, opDetail.permlink);
                break;
              } catch (err) {
                console.error(err);
                console.log(' - failed to get post content, retrying if possible');
              }
            }
            if (content === undefined || content === null) {
              console.log(' - completely failed to get post content, exiting');
              finishAndStoreLastInfos(startAtBlockNum, currentBlockNum - 1, function () {
                callback();
              });
              return;
            }

            // check payout window still open
            var recordOnly = false;
            var cashoutTime = moment(content.cashout_time);
            var nowTime = moment(new Date());
            cashoutTime.subtract(7, 'hours');
            if (!nowTime.isBefore(cashoutTime)) {
              console.log('payout window now closed, only keep record,' +
                  ' do not consider for flag');
              recordOnly = true;
            }

            var voteDetail = null;
            var countedNetRshares = 0;
            for (var m = 0; m < content.active_votes.length; m++) {
              countedNetRshares += Number(content.active_votes[m].rshares);
              if (content.active_votes[m].voter.localeCompare(opDetail.voter) === 0) {
                voteDetail = content.active_votes[m];
                if (!recordOnly) {
                  break;
                }
              }
            }
            if (voteDetail === null) {
              console.log('vote details null, cannot process, skip');
              continue;
            }

            // THEN, check if vote rshares are > 0
            // note: cancelled self votes have rshares == 0
            if (Number(voteDetail.rshares) < 0) {
              console.log(' - - self flag');
            } else if (Number(voteDetail.rshares) === 0) {
              console.log(' - - self vote negated');
            }

            console.log(':: self vote at b ' + i + ':t ' + j + ':op ' +
              k + ', detail:' + JSON.stringify(opDetail));

            // consider for flag queue
            var maxPayout = 0;
            var netRshares = 0;
            if (!recordOnly) {
              console.log('content.pending_payout_value: ' + content.pending_payout_value);
              var pendingPayoutValue = content.pending_payout_value.split(' ');
              maxPayout = Number(pendingPayoutValue[0]);
              netRshares = Number(content.net_rshares);
            } else {
              console.log('content.total_payout_value: ' + content.total_payout_value);
              var totalPayoutValue = content.total_payout_value.split(' ');
              maxPayout = Number(totalPayoutValue[0]);
              netRshares = countedNetRshares;
            }
            console.log('netRshares: ' + netRshares);

            if (netRshares <= 0) {
              console.log(' - self vote does not contribute to a reward, skipping');
              continue;
            }

            var selfVotePayout;
            if (maxPayout <= 0.00) {
              selfVotePayout = 0;
            } else if (content.active_votes.length === 1 ||
                  Number(voteDetail.rshares) === Number(netRshares)) {
              selfVotePayout = maxPayout;
            } else {
              selfVotePayout = maxPayout * (Number(voteDetail.rshares) / Number(netRshares));
            }
            console.log('selfVotePayout: ' + selfVotePayout);
            if (selfVotePayout < lib.MIN_SELF_VOTE_TO_CONSIDER) {
              console.log(' - self vote too small to consider');
              continue;
            }

            // *** FLAG
            // check if voter is on the flag mTestAuthorList
            var voterIsOnFlagList = false;
            var voterFlagObj = null;
            try {
              voterFlagObj = wait.for(lib.getRecordFromDb, lib.DB_FLAGLIST, {voter: opDetail.voter});
              if (voterFlagObj !== undefined &&
                  voterFlagObj !== null) {
                voterIsOnFlagList = true;
              }
            } catch (err) {
              // don't worry if this fails
            }

            var delegationsInfos = null;
            try {
              delegationsInfos = wait.for(lib.getRecordFromDb, lib.DB_DELEGATIONS, {user: opDetail.voter});
            } catch (err) {
              // do nothing
            }
            var steemPower = null;
            if (delegationsInfos !== undefined && delegationsInfos !== null) {
              steemPower = delegationsInfos.sp;
              console.log(' - checking delegation information, most recent SP is ' + steemPower);
              var correctionSP = 0;
              var delegators = [];
              for (m = 0; m < delegationsInfos.received.length; m++) {
                var delegationMoment = moment(delegationsInfos.received[m].timestamp, moment.ISO_8601);
                if (delegationMoment.isAfter(thisBlockMoment)) {
                  var alreadyProcessed = false;
                  for (var n = 0; n < delegators.length; n++) {
                    if (delegators[n].localeCompare(delegationsInfos.received[m].user) === 0) {
                      alreadyProcessed = true;
                    }
                  }
                  if (alreadyProcessed) {
                    continue;
                  }
                  delegators.push(delegationsInfos.received[m].user);
                  var sp = delegationsInfos.received[m].sp;
                  for (n = 0; n < delegationsInfos.received.length; n++) {
                    if (m !== n) {
                      var delegationMomentOther = moment(delegationsInfos.received[n].timestamp, moment.ISO_8601);
                      if (delegationsInfos.received[m].user.localeCompare(delegationsInfos.received[n].user) === 0 &&
                          delegationMomentOther.isAfter(delegationMoment) &&
                          sp !== delegationsInfos.received[n].sp) { // don't compound a duplicate delegation transaction
                        if ((sp > 0 && delegationsInfos.received[n].sp > 0) ||
                            (sp < 0 && delegationsInfos.received[n].sp < 0)) { // if same sign, replace
                          sp = delegationsInfos.received[n].sp;
                        } else {
                          sp += delegationsInfos.received[n].sp; // otherwise add
                        }
                      }
                    }
                  }
                  console.log(' - - - receieved ' + sp + ' from ' + delegationsInfos.received[m].user + ' after this vote, reverse');
                  correctionSP -= sp; // remove receieved delegations
                }
              }
              delegators = [];
              for (m = 0; m < delegationsInfos.delegated.length; m++) {
                delegationMoment = moment(delegationsInfos.delegated[m].timestamp, moment.ISO_8601);
                if (delegationsInfos.delegated[m].sp <= 0) {
                  delegationMoment = delegationMoment.add(Number(7, 'day'));
                }
                if (delegationMoment.isAfter(thisBlockMoment)) {
                  alreadyProcessed = false;
                  for (n = 0; n < delegators.length; n++) {
                    if (delegators[n].localeCompare(delegationsInfos.delegated[m].user) === 0) {
                      alreadyProcessed = true;
                    }
                  }
                  if (alreadyProcessed) {
                    continue;
                  }
                  delegators.push(delegationsInfos.delegated[m].user);
                  sp = delegationsInfos.delegated[m].sp;
                  for (n = 0; n < delegationsInfos.delegated.length; n++) {
                    if (m !== n) {
                      delegationMomentOther = moment(delegationsInfos.delegated[n].timestamp, moment.ISO_8601);
                      if (delegationsInfos.delegated[n].sp <= 0) {
                        delegationMomentOther = delegationMomentOther.add(Number(7, 'day'));
                      }
                      if (delegationsInfos.delegated[m].user.localeCompare(delegationsInfos.delegated[n].user) === 0 &&
                          delegationMomentOther.isAfter(delegationMoment) &&
                          sp !== delegationsInfos.delegated[n].sp) { // don't compound a duplicate delegation transaction
                        if ((sp > 0 && delegationsInfos.delegated[n].sp > 0) ||
                            (sp < 0 && delegationsInfos.delegated[n].sp < 0)) { // if same sign, replace
                          sp = delegationsInfos.delegated[n].sp;
                        } else {
                          sp += delegationsInfos.delegated[n].sp; // otherwise add
                        }
                      }
                    }
                  }
                  console.log(' - - - delegated ' + sp + ' to ' + delegationsInfos.delegated[m].user + ' after this vote, reverse');
                  correctionSP += sp; // restore outward delegations
                }
              }
              steemPower -= correctionSP; // subtract to reverse effect
              console.log(' - - correcting SP for historical events by ' + correctionSP + ', SP now = ' + steemPower);
            } else {
              // get from API instead, no delegations info
              var accounts = null;
              tries = 0;
              while (tries < lib.API_RETRIES) {
                tries++;
                try {
                  accounts = wait.for(lib.getSteemAccounts, opDetail.voter);
                  break;
                } catch (err) {
                  console.error(err);
                  console.log(' - failed to get account for voter ' + opDetail.voter + ', retrying if possible');
                }
              }
              if (accounts === undefined || accounts === null) {
                console.log(' - completely failed to get voter account, exiting');
                finishAndStoreLastInfos(startAtBlockNum, currentBlockNum - 1, function () {
                  callback();
                });
                return;
              }
              var voterAccount = accounts[0];
              try {
                steemPower = lib.getSteemPowerFromVest(voterAccount.vesting_shares) +
                    lib.getSteemPowerFromVest(voterAccount.received_vesting_shares) -
                    lib.getSteemPowerFromVest(voterAccount.delegated_vesting_shares);
              } catch (err) {
                console.log('Get vesting shares for voter failed, skip this one');
                continue;
              }
            }

            if (steemPower < Number(process.env.MIN_SP)) {
              console.log('SP of ' + opDetail.voter + ' < min of ' + Number(process.env.MIN_SP) + ', skipping');
              continue;
            }

            // calculate cumulative extrapolated ROI
            var roi = 0;
            if (selfVotePayout > 0) {
              roi = (selfVotePayout / (steemPower * sbdPerSteem)) * 100;
            }
            // cap at 10^(-20) precision to avoid exponent form
            roi = Number(roi.toFixed(20));

            if (roi < lib.MIN_ROI_TO_CONSIDER) {
              console.log(' - self roi too small to consider');
              continue;
            }

            // update voter info
            if (voterInfos === null || voterInfos === undefined) {
              voterInfos = {
                voter: opDetail.voter,
                total_self_vote_payout: selfVotePayout,
                total_extrapolated_roi: roi,
                steem_power: steemPower,
                posts: []
              };
              voterInfos.posts.push({
                permlink: content.permlink,
                self_vote_payout: selfVotePayout,
                extrapolated_roi: roi,
                flagged: false,
                to_flag: voterIsOnFlagList,
                weight: opDetail.weight
              });
              if (voterIsOnFlagList) {
                voterFlagObj.posts.push({
                  permlink: content.permlink,
                  self_vote_payout: selfVotePayout,
                  extrapolated_roi: roi,
                  flagged: false,
                  to_flag: true,
                  weight: opDetail.weight
                });
              }
            } else {
              voterInfos.total_self_vote_payout = voterInfos.total_self_vote_payout + selfVotePayout;
              voterInfos.steem_power = steemPower;
              voterInfos.total_extrapolated_roi += roi;
              // check for duplicate permlink, if so then update roi
              var isDuplicate = false;
              for (m = 0; m < voterInfos.posts.length; m++) {
                if (voterInfos.posts[m].permlink.localeCompare(content.permlink) === 0) {
                  console.log(' - - - new vote is duplicate on top list, replacing value');
                  voterInfos.posts[m].extrapolated_roi = roi;
                  // update total_extrapolated_roi
                  voterInfos.total_extrapolated_roi = 0;
                  for (var n = 0; n < voterInfos.posts.length; n++) {
                    voterInfos.total_extrapolated_roi += voterInfos.posts[n].extrapolated_roi;
                  }
                  if (voterInfos.to_flag === undefined) {
                    voterInfos.to_flag = voterIsOnFlagList;
                  }
                  if (voterInfos.weight === undefined) {
                    voterInfos.weight = opDetail.weight;
                  }
                  isDuplicate = true;
                  break;
                }
              }
              if (!isDuplicate) {
                voterInfos.posts.push(
                  {
                    permlink: content.permlink,
                    self_vote_payout: selfVotePayout,
                    extrapolated_roi: roi,
                    flagged: false,
                    to_flag: voterIsOnFlagList,
                    weight: opDetail.weight
                  }
                );
                if (voterIsOnFlagList) {
                  voterFlagObj.posts.push({
                    permlink: content.permlink,
                    self_vote_payout: selfVotePayout,
                    extrapolated_roi: roi,
                    flagged: false,
                    to_flag: voterIsOnFlagList,
                    weight: opDetail.weight
                  });
                }
              }
            }
            // console.log(" - - updated voter info:
            // "+JSON.stringify(voterInfos));

            // if (!recordOnly) {
            // update voter object if exists in queue already
            var updatedExistingQueueVoter = false;
            for (m = 0; m < queue.length; m++) {
              if (queue[m].voter.localeCompare(opDetail.voter) === 0) {
                queue[m] = voterInfos;
                console.log(' - - voter already in queue, updating');
                updatedExistingQueueVoter = true;
                break;
              }
            }

            // add voter object if didn't update existing
            if (!updatedExistingQueueVoter) {
              // if queue full then remove the lowest total ROI voter if below this voter
              if (queue.length >= lib.MAX_POSTS_TO_CONSIDER) {
                var idx = -1;
                var lowest = voterInfos.total_extrapolated_roi;
                for (m = 0; m < queue.length; m++) {
                  if (queue[m].total_extrapolated_roi < lowest) {
                    lowest = queue[m].total_extrapolated_roi;
                    idx = m;
                  }
                }

                if (idx >= 0) {
                  // remove lowest total ROI voter
                  console.log(' - - - removing existing lower roi user ' +
                      queue[idx].voter + ' with total extrapolated roi of ' +
                      queue[idx].total_extrapolated_roi);
                  var newPosts = [];
                  for (m = 0; m < queue.length; m++) {
                    if (m !== idx) {
                      newPosts.push(queue[m]);
                    }
                  }
                  queue = newPosts;
                }
              }
              if (queue.length < lib.MAX_POSTS_TO_CONSIDER) {
                // add to queue
                console.log(' - - - adding user to list');
                queue.push(voterInfos);
              } else {
                console.log(' - - - dont add user to list, below min in queue');
              }
            }
            // }

            wait.for(lib.saveDb, lib.DB_VOTERS, voterInfos);
            if (voterIsOnFlagList) {
              wait.for(lib.saveDb, lib.DB_FLAGLIST, voterFlagObj);
            }
            // console.log("* voter updated: "+JSON.stringify(voterInfos));
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
  wait.for(lib.saveDb, lib.DB_RUNS,
    {
      start_block: startAtBlockNum,
      end_block: currentBlockNum
    });
  var lastInfos = lib.getLastInfos();
  lastInfos.lastBlock = currentBlockNum;
  wait.for(lib.saveDb, lib.DB_RECORDS, lastInfos);
  lib.setLastInfos(lastInfos);
  // save queue, but drop it first as we are performing an overwrite
  try {
    wait.for(lib.dropDb, lib.DB_QUEUE);
  } catch (err) {
    console.log('Couldnt drop queue wrapper db, likely doesnt exist');
  }
  wait.for(lib.timeoutWait, 200);
  console.log(' - saving queue of length ' + queue.length);
  for (var i = 0; i < queue.length; i++) {
    console.log(' - - saving item ' + i + ': ' + JSON.stringify(queue[i]));
    wait.for(lib.saveDb, lib.DB_QUEUE, queue[i]);
  }
  callback();
}

function checkFinished (callback) {
  // check if scanned up to the current head block at time of start scan
  if (lib.getLastInfos().lastBlock >= lib.getLastInfos().last_delegation_block) {
    console.log(' - main bot script reached recent head, unblocking delegation script, will continue next run');
    var lastInfos = lib.getLastInfos();
    lastInfos.blocked = false;
    lastInfos.do_update_queue = true;
    wait.for(lib.saveDb, lib.DB_RECORDS, lastInfos);
    lib.setLastInfos(lastInfos);
  } else {
    var diff = lib.getProperties().head_block_number - lib.getLastInfos().lastBlock;
    console.log(' - main bot last processed block still ' + diff + ' blocks (' + (diff / (20 * 60)) + ' hr) away from head, will continue next run');
  }
  callback();
}

// START THIS SCRIPT
main();
