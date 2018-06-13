'use strict';

// const steem = require('steem');
const moment = require('moment');
// const S = require('string');
const wait = require('wait.for');
const lib = require('./lib.js');

const MIN_VOTE_WEIGHT_TO_CONSIDER = 30; // in percent, threshold of self vote considered big enough to count
// const OPTIMAL_NUM_VOTES = 70;
const OPTIMAL_VOTING_INTERVAL_MS = 2.4 * 60 * 60 * 1000; // 2.4 hrs in milliseconds
const TAIL_FACTOR = 2; // how long does the after optimal voting time take to fade to zero, as a factor of optimal voting interval time

const OUTGOING_VP_ADJ_PC_MIN = 80;
const OUTGOING_VP_ADJ_PC_MAX = 100;
const OUTGOING_VARI_LOCAL_GOOD_AMT = 4;
// const OUTGOING_VARI_GOOD_AMT = OUTGOING_VARI_LOCAL_GOOD_AMT * OPTIMAL_NUM_VOTES;

const OPT_PERIOD_SCORE_FACTOR = 1;
const OUTGOING_VP_ADJ_SCORE_FACTOR = -0.4;
const OUTGOING_VARI_SCORE_FACTOR = -0.2;
const OUTGOING_VARI_ABS_SCORE_FACTOR = -0.4;

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

            // completely ignore zero weight votes and error in author
            if (opDetail.weight <= 0 || opDetail.author == null) {
              continue;
            }

            // THEN, check vote is a self vote
            var selfVote = opDetail.voter.localeCompare(opDetail.author) === 0;

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
                voterInfos = recordSelfVote(voterInfos, opDetail, thisBlockMoment);
                wait.for(lib.saveDb, lib.DB_VOTERS, voterInfos);
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
              // record username for variance testing
              var match = false;
              // local
              for (var m = 0; m < voterInfos.outgoing_voter_list_local.length; m++) {
                if (voterInfos.outgoing_voter_list_local[m] == null) {
                  console.log(' ** fatal error, null entry in voterInfos.outgoing_voter_list_local[' + m + ']');
                  console.log(' - ' + JSON.stringify(voterInfos));
                  console.log(' - - outgoing_voter_list[]: ' + JSON.stringify(voterInfos.outgoing_voter_list));
                  console.log(' - - outgoing_voter_list_local[]: ' + JSON.stringify(voterInfos.outgoing_voter_list_local));
                  callback();
                  return;
                }
                if (voterInfos.outgoing_voter_list_local[m].localeCompare(opDetail.author) === 0) {
                  match = true;
                  break;
                }
              }
              if (!match) {
                if (opDetail.author == null) {
                  console.log(' ** fatal error, author null for opDetail: ' + JSON.stringify(opDetail));
                  callback();
                  return;
                }
                voterInfos.outgoing_voter_list_local.push(opDetail.author);
              }
              voterInfos.outgoing_voter_list_local_weight_sum += opDetail.weight / 10000;
              // general
              match = false;
              for (m = 0; m < voterInfos.outgoing_voter_list.length; m++) {
                if (voterInfos.outgoing_voter_list[m] == null) {
                  console.log(' ** fatal error, null entry in voterInfos.outgoing_voter_list[' + m + ']');
                  console.log(' - ' + JSON.stringify(voterInfos));
                  console.log(' - - outgoing_voter_list[]: ' + JSON.stringify(voterInfos.outgoing_voter_list));
                  console.log(' - - outgoing_voter_list_local[]: ' + JSON.stringify(voterInfos.outgoing_voter_list_local));
                  callback();
                  return;
                }
                if (voterInfos.outgoing_voter_list[m].localeCompare(opDetail.author) === 0) {
                  match = true;
                  break;
                }
              }
              if (!match) {
                if (opDetail.author == null) {
                  console.log(' ** fatal error, author null for opDetail: ' + JSON.stringify(opDetail));
                  callback();
                  return;
                }
                voterInfos.outgoing_voter_list.push(opDetail.author);
                voterInfos.outgoing_voter_list_count = voterInfos.outgoing_voter_list.length;
              }
              voterInfos.outgoing_voter_list_weight_sum += opDetail.weight / 10000;
              // case #2, if previous self vote exists and vote is outward vote
              // reduce bVP by amount of vote
              voterInfos.bVP *= 0.98 * (opDetail.weight / 10000);
              // record last vote time
              voterInfos.last_vote_time = thisBlockMoment.valueOf();
              wait.for(lib.saveDb, lib.DB_VOTERS, voterInfos);
              continue;
            }
            // else from here on is self vote...

            if ((opDetail.weight / 100) < MIN_VOTE_WEIGHT_TO_CONSIDER) {
              console.log(' - self vote below min threshold of ' + MIN_VOTE_WEIGHT_TO_CONSIDER + ', ignoring, except to adjust bVP');
              voterInfos.bVP *= 0.98 * (opDetail.weight / 10000);
              voterInfos.last_vote_time = thisBlockMoment.valueOf();
              wait.for(lib.saveDb, lib.DB_VOTERS, voterInfos);
              continue;
            }

            // case #3, if previous self vote exists and vote is self vote
            // * calc self vote score. score is normalized, i.e. between 0 and 1
            // 1. get difference in self vote times, in milliseconds
            console.log('calc score for @' + opDetail.voter + '/' + opDetail.permlink);
            var optPeriodScore = 0;
            var diff = thisBlockMoment.valueOf() - voterInfos.svt;
            if (diff < OPTIMAL_VOTING_INTERVAL_MS) {
              console.log(' - earlier than optimal voting, at ' + (diff / 1000 / 60) + ' mins');
              optPeriodScore = diff / OPTIMAL_VOTING_INTERVAL_MS;
              // score *= score;
            } else if (optPeriodScore < (OPTIMAL_VOTING_INTERVAL_MS * (TAIL_FACTOR + 1))) {
              console.log(' - later than optimal voting, at ' + (diff / 1000 / 60) + ' mins');
              optPeriodScore = (diff - OPTIMAL_VOTING_INTERVAL_MS) / (OPTIMAL_VOTING_INTERVAL_MS * TAIL_FACTOR);
              // score *= score;
              optPeriodScore = 1 - optPeriodScore;
            }
            console.log(' - - optimal period score before weight attenuation = ' + optPeriodScore);
            // attenuate by voting weight
            optPeriodScore *= (opDetail.weight / 10000);
            console.log(' - - score after weight adjustment of ' + (opDetail.weight / 100) + '% = ' + optPeriodScore);
            voterInfos.opt_period_score += optPeriodScore;
            // reduce score by adjusted amount of VP lost from outward votes
            var outgoingVpAdjScore = voterInfos.bVP - OUTGOING_VP_ADJ_PC_MIN;
            if (outgoingVpAdjScore !== 0) {
              outgoingVpAdjScore /= OUTGOING_VP_ADJ_PC_MAX - OUTGOING_VP_ADJ_PC_MIN;
            }
            outgoingVpAdjScore = 1 - outgoingVpAdjScore;
            if (outgoingVpAdjScore < 0) {
              outgoingVpAdjScore = 0;
            }
            if (outgoingVpAdjScore > 1) {
              outgoingVpAdjScore = 1;
            }
            console.log(' - - outgoing VP adjustment score for bVP ' + voterInfos.bVP + '%, score = ' + outgoingVpAdjScore);
            voterInfos.outgoing_vp_adj_score += outgoingVpAdjScore;
            // record outgoing vote variances
            var outgoingVariLocalScore = 0;
            var outgoingVariAbsLocalScore = 0;
            if (voterInfos.outgoing_voter_list_local.length > 0) {
              outgoingVariLocalScore = voterInfos.outgoing_voter_list_local.length / voterInfos.outgoing_voter_list_local_weight_sum;
              voterInfos.outgoing_vari_local_score += outgoingVariLocalScore;
              outgoingVariAbsLocalScore = voterInfos.outgoing_voter_list_local.length > OUTGOING_VARI_LOCAL_GOOD_AMT ? 1 : voterInfos.outgoing_voter_list_local.length / OUTGOING_VARI_LOCAL_GOOD_AMT;
              voterInfos.outgoing_vari_abs_local_score += outgoingVariAbsLocalScore;
              console.log(' - - outgoing vari local score (size ' + voterInfos.outgoing_voter_list_local.length + ' / sum ' +
                  voterInfos.outgoing_voter_list_local_weight_sum + ') = ' + outgoingVariLocalScore);
              console.log(' - - outgoing vari abs local score (size ' + voterInfos.outgoing_voter_list_local.length + ' / TARGET_AMT ' +
                  OUTGOING_VARI_LOCAL_GOOD_AMT + ') = ' + outgoingVariAbsLocalScore);
            }
            if (voterInfos.outgoing_voter_list.length > 0) {
              console.log(' - - tracking outgoing vari local score (size ' + voterInfos.outgoing_voter_list.length + ' / sum ' +
                  voterInfos.outgoing_voter_list_weight_sum + ') = raw ' + (voterInfos.outgoing_voter_list.length / voterInfos.outgoing_voter_list_weight_sum));
            }
            // create combination score
            var score = optPeriodScore * OPT_PERIOD_SCORE_FACTOR;
            score += outgoingVpAdjScore * OUTGOING_VP_ADJ_SCORE_FACTOR;
            score += outgoingVariLocalScore * OUTGOING_VARI_SCORE_FACTOR;
            score += outgoingVariAbsLocalScore * OUTGOING_VARI_ABS_SCORE_FACTOR;
            console.log(' - - - combined score: ' + score);
            if (score > 0) {
              if (score > 1) {
                score = 1;
              }
              console.log(' - - - saved as score: ' + score);
              voterInfos.score += score;
            } else {
              console.log(' - - - not saving negative score');
            }
            // finally, record this self vote
            voterInfos = recordSelfVote(voterInfos, opDetail, thisBlockMoment);

            var updatedExistingQueueVoter = false;
            for (m = 0; m < queue.length; m++) {
              if (queue[m].voter.localeCompare(opDetail.voter) === 0) {
                queue[m] = voterInfos;
                // console.log(' - - voter already in queue, updating');
                updatedExistingQueueVoter = true;
                break;
              }
            }
            // add voter object if didn't update existing
            if (!updatedExistingQueueVoter) {
              // if queue full then remove the lowest total ROI voter if below this voter
              if (queue.length >= lib.MAX_POSTS_TO_CONSIDER) {
                var idx = -1;
                var lowest = voterInfos.score;
                for (m = 0; m < queue.length; m++) {
                  if (queue[m].score < lowest) {
                    lowest = queue[m].score;
                    idx = m;
                  }
                }

                if (idx >= 0) {
                  // remove lowest total ROI voter
                  /*
                  console.log(' - - - removing existing lower score user ' +
                      queue[idx].voter + ' with score of ' +
                      queue[idx].score);
                      */
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
                // console.log(' - - - dont add user to list, below min in queue');
              }
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
      opt_period_score: 0,
      outgoing_vp_adj_score: 0,
      outgoing_vari_score: 0,
      outgoing_vari_local_score: 0,
      outgoing_vari_abs_local_score: 0,
      bVP: 98,
      svt: blockMoment.valueOf(),
      last_vote_time: blockMoment.valueOf(),
      outgoing_voter_list: [],
      outgoing_voter_list_count: 0,
      outgoing_voter_list_weight_sum: 0,
      outgoing_voter_list_local: [],
      outgoing_voter_list_local_weight_sum: 0,
      self_vote_weight_sum: opDetail.weight / 10000
    };
  } else {
    // before bVP reset, use bVP
    voterInfos.self_vote_weight_sum += (opDetail.weight / 10000) * (voterInfos.bVP / 100);
    // then continue
    voterInfos.bVP = 98;
    voterInfos.svt = blockMoment.valueOf();
    voterInfos.last_vote_time = blockMoment.valueOf();
    voterInfos.outgoing_voter_list_local = [];
    voterInfos.outgoing_voter_list_local_weight_sum = 0;
  }
  return voterInfos;
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
