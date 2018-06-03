'use strict';

// const steem = require('steem');
const moment = require('moment');
// const S = require('string');
const wait = require('wait.for');
const lib = require('./lib.js');

const OPTIMAL_NUM_VOTES = 70;
const OPTIMAL_VOTING_INTERVAL_MS = 2.4 * 60 * 60 * 1000; // 2.4 hrs in milliseconds
const TAIL_FACTOR = 3; // how long does the after optimal voting time take to fade to zero, as a factor of optimal voting interval time

function main () {
  console.log(' *** BOT.js');
  process.on('unhandledRejection', (reason, p) => {
    console.log('Unhandled Rejection at: Promise', p, 'reason:', reason);
    process.exit(1);
  });
  lib.start(function () {
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
    var tries = 0; // declare much used variable for API failure management
    // set up initial variables
    console.log('Getting blockchain info');
    var maxBlockNum = lib.getProperties().head_block_number;
    if (startAtBlockNum >= maxBlockNum) {
      console.log(' - no blocks to run, have reached current max at ' + maxBlockNum);
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
            // try to get voter info from db
            var voterInfos = wait.for(lib.getRecordFromDb, lib.DB_VOTERS, {voter: opDetail.voter});

            // THEN, check vote is a self vote
            var selfVote = opDetail.voter.localeCompare(opDetail.author) !== 0;

            if (selfVote) {
              // check if on flag list first to add this voted post to list for countering
              var voterFlagObj = null;
              try {
                voterFlagObj = wait.for(lib.getRecordFromDb, lib.DB_FLAGLIST, {voter: opDetail.voter});
              } catch (err) {
                // fail silently
              }
              if (voterFlagObj !== undefined &&
                  voterFlagObj != null) {
                if (voterFlagObj.posts === undefined) {
                  voterFlagObj.posts = [];
                }
                voterFlagObj.posts.push({
                  permlink: opDetail.permlink,
                  weight: opDetail.weight,
                  flagged: false
                });
                wait.for(lib.saveDb, lib.DB_FLAGLIST, voterFlagObj);
              }
            }

            // case #1, if first self vote on record for user
            if (voterInfos === null || voterInfos === undefined) {
              if (selfVote) {
                recordSelfVote(voterInfos, opDetail, thisBlockMoment);
              }
              continue;
            }

            // for both case #2 and #3
            // regenerate balance VP (bVP) by interviening time
            voterInfos.bVP += calcVotingPowerRegen(voterInfos.last_vote_time, thisBlockMoment.valueOf());
            if (voterInfos.bVP > 100) {
              voterInfos.bVP = 100;
            }

            if (!selfVote) {
              // case #2, if previous self vote exists and vote is outward vote
              // reduce bVP by amount of vote
              if (opDetail.weight > 0) { // note: we ignore reseting votes which vote again for some vote at zero
                voterInfos.bVP *= 0.98 * (opDetail.weight / 10000);
              }
              // record last vote time
              voterInfos.last_vote_time = thisBlockMoment.valueOf();
            } else {
              // case #3, if previous self vote exists and vote is self vote
              // * calc self vote score. score is normalized, i.e. between 0 and 1
              // 1. get difference in self vote times, in milliseconds
              console.log('calc score for @' + opDetail.author + '/' + opDetail.permlink);
              var score = 0;
              var diff = thisBlockMoment.valueOf() - voterInfos.svt;
              if (diff < OPTIMAL_VOTING_INTERVAL_MS) {
                console.log(' - earlier than optimal voting, at ' + (diff / 1000 / 60) + ' mins');
                score = diff / OPTIMAL_VOTING_INTERVAL_MS;
                score *= score;
              } else if (score < (OPTIMAL_VOTING_INTERVAL_MS * (TAIL_FACTOR + 1))) {
                console.log(' - later than optimal voting, at ' + (diff / 1000 / 60) + ' mins');
                score = (diff - OPTIMAL_VOTING_INTERVAL_MS) / (OPTIMAL_VOTING_INTERVAL_MS * TAIL_FACTOR);
                score *= score;
                score = 1 - score;
              }
              console.log(' - - score = ' + score);
              // reduce score by adjusted amount of VP lost from outward votes
              // TODO : perhaps it's too much for it to be reduced by 100% to fully remove score? maybe a lower amount?
              score -= 1 - (voterInfos.bVP > 0 ? (voterInfos.bVP / 100) : 1);
              console.log(' - - reduced score relative to ' + voterInfos.bVP + ' voting power balance, score = ' + score);
              // if we have a positive score, add it to the users score, adjusted for number of optimal votes
              if (score > 0) {
                voterInfos.score += (score / OPTIMAL_NUM_VOTES);
                console.log(' - - - added adjusted score of ' + (score / OPTIMAL_NUM_VOTES) + ' resulting in ' + voterInfos.score + ' total score for ' + opDetail.author);
              }
              // finally, record this self vote
              recordSelfVote(voterInfos, opDetail, thisBlockMoment);
            }

            // if queue full then remove the lowest total ROI voter if below this voter
            if (voterInfos.score > 0) {
              if (queue.length >= lib.MAX_POSTS_TO_CONSIDER) {
                var idx = -1;
                var lowest = voterInfos.score;
                for (var m = 0; m < queue.length; m++) {
                  if (queue[m].score < lowest) {
                    lowest = queue[m].score;
                    idx = m;
                  }
                }

                if (idx >= 0) {
                  // remove lowest total ROI voter
                  console.log(' - - removing existing lower score user ' +
                      queue[idx].voter + ' with score of ' +
                      queue[idx].score);
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
                console.log(' - - adding user to list');
                queue.push(voterInfos);
              } else {
                // console.log(' - - dont add user to list, below min in queue');
              }
            } else {
              // console.log(' - - don't );
            }

            wait.for(lib.saveDb, lib.DB_VOTERS, voterInfos);
          }
        }
      }
    }
    finishAndStoreLastInfos(startAtBlockNum, currentBlockNum, function () {
      callback();
    });
  });
}

/*
 * Must be called from Wait.For Fiber
 */
function recordSelfVote (voterInfos, opDetail, blockMoment) {
  if (voterInfos == null) {
    voterInfos = {
      voter: opDetail.voter,
      score: 0,
      bVP: 98,
      svt: blockMoment.valueOf(),
      last_vote_time: blockMoment.valueOf()
    };
  } else {
    voterInfos.bVP = 98;
    voterInfos.svt = blockMoment.valueOf();
    voterInfos.last_vote_time = blockMoment.valueOf();
  }
  wait.for(lib.saveDb, lib.DB_VOTERS, voterInfos);
}

function calcVotingPowerRegen (fromTimestamp, toTimestamp) {
  var secondsDiff = (toTimestamp - fromTimestamp) / 1000;
  if (secondsDiff > 0) {
    return secondsDiff * 10000 / 86400 / 5;
  }
  return 0;
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

// START THIS SCRIPT
main();
