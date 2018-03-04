'use strict';

const steem = require('steem');
const moment = require('moment');
// const S = require('string');
const wait = require('wait.for');
const lib = require('./lib.js');

var MAX_POSTS_TO_CONSIDER = 20; // default
var MIN_SELF_VOTE_TO_CONSIDER = 0.001;
var MIN_ROI_TO_CONSIDER = 0.000001;

function main () {
  // get more information on unhandled promise rejections
  process.on('unhandledRejection', (reason, p) => {
    console.log('Unhandled Rejection at: Promise', p, 'reason:', reason);
    // application specific logging, throwing an error, or other logic here
    process.exit(1);
  });
  lib.start(function () {
    if (lib.getLastInfos().blocked) {
      console.log('Day blocked - edit value to unblock');
      setTimeout(function () {
        process.exit();
      }, 5000);
      return;
    }
    doProcess(lib.getLastInfos().lastBlock + 1, function () {
      console.log('Finished');
      setTimeout(function () {
        process.exit();
      }, 5000);
    });
  });
}

var queue = [];

function doProcess (startAtBlockNum, callback) {
  wait.launchFiber(function () {
    // set up initial variables
    console.log('Getting blockchain info');
    try {
      var headBlock = wait.for(lib.getBlockHeader, lib.getProperties().head_block_number);
      var latestBlockMoment = moment(headBlock.timestamp, moment.ISO_8601);
      // chain stuff
      var rewardFundInfo = wait.for(lib.getRewardFund, 'post');
      console.log('Reward fund info: ' + JSON.stringify(rewardFundInfo));
      var priceInfo = wait.for(lib.getCurrentMedianHistoryPrice);
      console.log('Price info: ' + JSON.stringify(priceInfo));

      var rewardBalance = rewardFundInfo.reward_balance;
      var recentClaims = rewardFundInfo.recent_claims;
      var rewardPool = rewardBalance.replace(' STEEM', '') / recentClaims;

      var sbdPerSteem = priceInfo.base.replace(' SBD', '') / priceInfo.quote.replace(' STEEM', '');

      var steemPerVest = lib.getProperties().total_vesting_fund_steem.replace(' STEEM', '') /
          lib.getProperties().total_vesting_shares.replace(' VESTS', '');

      // var steemMarketData = wait.for(requestJsonFromUrlWrapper, lib.MARKET_VALUE_REQ_URL_STEEM);
      // var sbdMarketData = wait.for(requestJsonFromUrlWrapper, lib.MARKET_VALUE_REQ_URL_SBD);
      // console.log('from ' + lib.MARKET_VALUE_REQ_URL_STEEM + ': ' + JSON.stringify(steemMarketData));
      // console.log('from ' + lib.MARKET_VALUE_REQ_URL_SBD + ': ' + JSON.stringify(sbdMarketData));
      // var steemMarketPrice = steemMarketData[0].price_usd;
      // var sbdMarketPrice = sbdMarketData[0].price_usd;
      // console.log('Market prices: 1 STEEM = US$ ' + steemMarketPrice + ', 1 SBD = US$ ' + sbdMarketPrice);
    } catch (err) {
      console.error(err);
      callback();
      return;
    }

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
    var firstBlockMoment = null;
    var currentBlockNum = startAtBlockNum;
    var dayBlocked = false;
    var endTime = moment(new Date()).add(Number(process.env.MAX_MINS_TO_RUN), 'minute');
    for (var i = startAtBlockNum; i <= lib.getProperties().head_block_number; i++) {
      currentBlockNum = i;
      if (moment(new Date()).isAfter(endTime)) {
        console.log('Max time reached, stopping');
        currentBlockNum--;
        break;
      }
      try {
        var block = wait.for(lib.getBlock, i);
      } catch (err) {
        console.log('Getting block failed, finish gracefully');
        finishAndStoreLastInfos(startAtBlockNum, currentBlockNum - 1, dayBlocked, function () {
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
          dayBlocked = true;
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

            // get account for voter
            try {
              var accounts = wait.for(lib.getSteemAccounts, opDetail.voter);
            } catch (err) {
              console.log('Get accounts for voter failed, finish gracefully');
              finishAndStoreLastInfos(startAtBlockNum, currentBlockNum - 1, dayBlocked, function () {
                callback();
              });
              return;
            }
            var voterAccount = accounts[0];
            try {
              var steemPower = lib.getSteemPowerFromVest(voterAccount.vesting_shares) +
                  lib.getSteemPowerFromVest(voterAccount.received_vesting_shares) -
                  lib.getSteemPowerFromVest(voterAccount.delegated_vesting_shares);
            } catch (err) {
              console.log('Get vesting shares for voter failed, finish gracefully');
              finishAndStoreLastInfos(startAtBlockNum, currentBlockNum - 1, dayBlocked, function () {
                callback();
              });
              return;
            }

            // get post content and rshares of vote
            var content = null;
            try {
              content = wait.for(lib.getPostContent, opDetail.author, opDetail.permlink);
            } catch (err) {
              console.log('Get post content failed, finish gracefully');
              finishAndStoreLastInfos(startAtBlockNum, currentBlockNum - 1, dayBlocked, function () {
                callback();
              });
              return;
            }
            if (content === undefined || content === null) {
              console.log('Couldnt process operation, continuing.' +
                ' Error: post content response not defined');
              continue;
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
              countedNetRshares += content.active_votes[m].rshares;
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
            if (voteDetail.rshares < 0) {
              console.log(' - - self flag');
            } else if (voteDetail.rshares === 0) {
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
              netRshares = content.net_rshares;
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
                  voteDetail.rshares === Number(netRshares)) {
              selfVotePayout = maxPayout;
            } else {
              selfVotePayout = maxPayout * (voteDetail.rshares / Number(netRshares));
            }
            console.log('selfVotePayout: ' + selfVotePayout);
            if (selfVotePayout < MIN_SELF_VOTE_TO_CONSIDER) {
              console.log(' - self vote too small to consider');
              continue;
            }

            // *** FLAG
            // check if voter is on the flag mTestAuthorList
            try {
              var voterToFlag = wait.for(lib.getRecordFromDb, lib.DB_FLAGLIST, {voter: opDetail.voter});
              if (voterToFlag !== undefined &&
                  voterToFlag !== null) {
                // get content for this post first, can reuse below also
                try {
                  content = wait.for(lib.getPostContent, opDetail.author, opDetail.permlink);
                } catch (err) {
                  console.log('Get post content failed for voterToFlag, finish gracefully');
                  finishAndStoreLastInfos(startAtBlockNum, currentBlockNum - 1, dayBlocked, function () {
                    callback();
                  });
                  return;
                }
                if (content === undefined || content === null) {
                  console.log('Couldnt process operation, continuing.' +
                    ' Error: post content response not defined');
                  continue;
                }
                wait.for(flagVoter, selfVotePayout, content, latestBlockMoment, steemPerVest, rewardPool, sbdPerSteem);
              }
            } catch (err) {
              // don't worry if this fails
            }

            if (steemPower < lib.MIN_SP) {
              console.log('SP of ' + opDetail.voter + ' < min of ' + lib.MIN_SP + ', skipping');
              continue;
            }

            // calculate cumulative extrapolated ROI
            var roi = 0;
            if (selfVotePayout > 0) {
              roi = (selfVotePayout / (steemPower * sbdPerSteem)) * 100;
            }
            // cap at 10^(-20) precision to avoid exponent form
            roi = Number(roi.toFixed(20));

            if (roi < MIN_ROI_TO_CONSIDER) {
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
                posts: [
                  {
                    permlink: content.permlink,
                    self_vote_payout: selfVotePayout,
                    extrapolated_roi: roi
                  }
                ]
              };
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
                  isDuplicate = true;
                  break;
                }
              }
              if (!isDuplicate) {
                voterInfos.posts.push(
                  {
                    permlink: content.permlink,
                    self_vote_payout: selfVotePayout,
                    extrapolated_roi: roi
                  }
                );
              }
            }
            // console.log(" - - updated voter info:
            // "+JSON.stringify(voterInfos));

            if (!recordOnly) {
              // first sort with lowest first
              /*
              queue.sort(function (a, b) {
                return a.total_extrapolated_roi - b.total_extrapolated_roi;
              });
              */

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
                if (queue.length >= MAX_POSTS_TO_CONSIDER) {
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
                if (queue.length < MAX_POSTS_TO_CONSIDER) {
                  // add to queue
                  console.log(' - - - adding user to list');
                  queue.push(voterInfos);
                } else {
                  console.log(' - - - dont add user to list, below min in queue');
                }
              }
            }

            wait.for(lib.saveDb, lib.DB_VOTERS, voterInfos);
            // console.log("* voter updated: "+JSON.stringify(voterInfos));
          }
        }
      }
    }
    finishAndStoreLastInfos(startAtBlockNum, currentBlockNum, dayBlocked, function () {
      callback();
    });
  });
}

function finishAndStoreLastInfos (startAtBlockNum, currentBlockNum, dayBlocked, callback) {
  console.log('Processed from block ' + startAtBlockNum + ' to ' + currentBlockNum);
  wait.for(lib.saveDb, lib.DB_RUNS,
    {
      start_block: startAtBlockNum,
      end_block: currentBlockNum
    });
  var lastInfos = lib.getLastInfos();
  lastInfos.lastBlock = currentBlockNum;
  if (dayBlocked) {
    lastInfos.blocked = true;
  }
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

function flagVoter (selfVotePayout, content, latestBlockMoment, steemPerVest, rewardPool, sbdPerSteem, callback) {
  var accounts = wait.for(lib.steem_getAccounts_wrapper, process.env.STEEM_USER);
  lib.setAccount(accounts[0]);
  var vp = recalcVotingPower(latestBlockMoment);

  console.log('\n - VP is at ' + (vp / 100).toFixed(2) + ' %');
  if ((vp / 100).toFixed(2) < Number(process.env.MIN_VP)) {
    console.log('\n - - VP less than min of ' + Number(process.env.MIN_VP) + ' %, exiting');
    callback();
    return;
  }

  var vestingSharesParts = lib.getAccount().vesting_shares.split(' ');
  var vestingSharesNum = Number(vestingSharesParts[0]);
  var receivedSharesParts = lib.getAccount().received_vesting_shares.split(' ');
  var receivedSharesNum = Number(receivedSharesParts[0]);
  var delegatedSharesParts = lib.getAccount().delegated_vesting_shares.split(' ');
  var delegatedSharesNum = Number(delegatedSharesParts[0]);
  var totalVests = vestingSharesNum + receivedSharesNum - delegatedSharesNum;

  var steempower = lib.getSteemPowerFromVest(totalVests);
  // console.log('steem power: ' + steempower);
  var spScaledVests = steempower / steemPerVest;
  var oneval = ((selfVotePayout * 10000 * 52) / (spScaledVests * 100 * rewardPool * sbdPerSteem));
  var votingpower = ((oneval / (100 * vp)) * lib.VOTE_POWER_1_PC) / 100;

  console.log('\n - strength to vote at: ' + votingpower.toFixed(2) + ' %');

  if (votingpower > 100) {
    console.log('\n - cant vote at ' + votingpower.toFixed(2) + '%, capping at 100%');
    votingpower = 100;
  }

  var percentageInt = parseInt(votingpower.toFixed(2) * lib.VOTE_POWER_1_PC);

  if (percentageInt === 0) {
    console.log('\n - percentage less than abs(0.01 %), skip.');
    callback();
    return;
  }

  // flip sign on percentage to turn into flagger
  percentageInt *= -1;

  console.log('\n - voting...');
  if (process.env.ACTIVE !== undefined &&
      process.env.ACTIVE !== null &&
      process.env.ACTIVE.localeCompare('true') === 0) {
    try {
      var voteResult = wait.for(steem.broadcast.vote,
        process.env.POSTING_KEY_PRV,
        process.env.STEEM_USER,
        content.author,
        content.permlink,
        percentageInt);
      console.log('Vote result: ' + JSON.stringify(voteResult));
    } catch (err) {
      console.log('Error voting: ' + JSON.stringify(err));
      callback();
      return;
    }
    console.log('\n - - wait 3.5 seconds to allow vote limit to reset');
    wait.for(lib.timeoutWait, 3500);
    console.log('\n - - - finished waiting');
  } else {
    console.log('\n - - bot not in active state, not voting');
  }
  callback();
}

function recalcVotingPower (latestBlockMoment) {
  // update account
  try {
    var accounts = wait.for(lib.getSteemAccounts, process.env.STEEM_USER);
  } catch (err) {
    console.error(err);
    return 0;
  }
  if (accounts === null || accounts === undefined) {
    console.log('Could not get bot account detail');
    return 0;
  }
  var account = accounts[0];
  lib.setAccount(accounts[0]);
  var vp = account.voting_power;
  var lastVoteTime = moment(account.last_vote_time);
  var secondsDiff = (latestBlockMoment.valueOf() - lastVoteTime.valueOf()) / 1000;
  if (secondsDiff > 0) {
    var vpRegenerated = secondsDiff * 10000 / 86400 / 5;
    vp += vpRegenerated;
  }
  if (vp > 10000) {
    vp = 10000;
  }
  // console.log(' - - new vp(corrected): '+vp);
  return vp;
}

// START THIS SCRIPT
main();
