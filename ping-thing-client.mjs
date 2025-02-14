// Sample use:
// node ping-thing-client.mjs >> ping-thing.log 2>&1 &

import dotenv from 'dotenv';
import web3 from '@solana/web3.js';
import bs58 from 'bs58';
import XMLHttpRequest from 'xhr2';

// Catch interrupts & exit
process.on(
  'SIGINT',
  function() {
    console.log(`${new Date().toISOString()} Caught interrupt signal`, '\n');
    process.exit();
  }
);

// Read constants from .env
dotenv.config();
const RPC_ENDPOINT = process.env.RPC_ENDPOINT;
const USER_KEYPAIR = web3.Keypair.fromSecretKey(
  bs58.decode(process.env.WALLET_PRIVATE_KEYPAIR)
);

const sleepMsRpc = process.env.SLEEP_MS_RPC || 2000;
const sleepMsLoop = process.env.SLEEP_MS_LOOP || 0;
const VA_API_KEY = process.env.VA_API_KEY;
// process.env.VERBOSE_LOG returns a string. e.g. 'true'
const VERBOSE_LOG = process.env.VERBOSE_LOG === 'true' ? true : false;
const commitmentLevel = process.env.COMMITMENT || 'confirmed';
const usePriorityFee = process.env.USE_PRIORITY_FEE == 'true' ? true : false;

// Set up web3 client
// const walletAccount = new web3.PublicKey(USER_KEYPAIR.publicKey);
const connection = new web3.Connection(RPC_ENDPOINT, commitmentLevel);

// Set up our REST client
const restClient = new XMLHttpRequest();

// Setup our transaction
const tx = new web3.Transaction();

if (usePriorityFee) {
  tx.add( 
    web3.ComputeBudgetProgram.setComputeUnitLimit({ 
      units: process.env.CU_BUDGET || 5000
    })
  );

  tx.add(
    web3.ComputeBudgetProgram.setComputeUnitPrice({ 
    microLamports: process.env.PRIORITY_FEE_MICRO_LAMPORTS || 3
    })
  );
}

tx.add(
  web3.SystemProgram.transfer({
    fromPubkey: USER_KEYPAIR.publicKey,
    toPubkey: USER_KEYPAIR.publicKey,
    lamports: 5000
  })
);

if (VERBOSE_LOG) console.log(`${new Date().toISOString()} Starting script`);

// Run inside a loop that will exit after 3 consecutive failures
let tryCount = 0;
const maxTries = 3;

// Pre-define loop constants & variables
const fakeSignature = '9999999999999999999999999999999999999999999999999999999999999999999999999999999999999999';
let uninterrupted = true;
let signature = undefined;
let txSuccess = undefined;
let slotSent = undefined;
let slotLanded = undefined;

// Create a connection to subscribe onSlotChange in the background and update a global variable
// so we can get the latest slot number
const connProcessed = new web3.Connection(RPC_ENDPOINT, 'processed');
let latestSlot = 0;

// Loop until interrupted
while( uninterrupted ) {
  // Create a subscription to the processed RPC endpoint
  const subscriptionId = connProcessed.onSlotChange(slotInfo => {
    latestSlot = slotInfo.slot;
  });
  // Sleep before the next loop and to let the subscription get warmed up
  await new Promise(r => setTimeout(r, sleepMsLoop));

  // continue if latestSlot is zero, undefined, or if the latestSlot is less than the slotSent
  if (latestSlot === 0 || latestSlot === undefined || latestSlot < slotSent) {
    console.log(`${new Date().toISOString()} Waiting for latestSlot to be updated...`);
    continue;
  }

  // reset these on each loop:
  signature = undefined;
  txSuccess = undefined;
  slotSent = undefined;
  slotLanded = undefined;

  try {
    // Set the current slot being processed
    slotSent = latestSlot;

    // Send the TX to the cluster
    const txStart = new Date();
    try {
      signature = await web3.sendAndConfirmTransaction(
        connection,
        tx,
        [USER_KEYPAIR],
        { commitment: commitmentLevel, skipPreflight: true }
      );
      
      txSuccess = true;
    } catch (e) {
      // Log and loop if we get a bad blockhash.
      if (e.message.includes('new blockhash')) {
        console.log(`${new Date().toISOString()} ERROR: Unable to obtain a new blockhash`);
        continue;
      } else if (e.message.includes('Blockhash not found')) {
        console.log(`${new Date().toISOString()} ERROR: Blockhash not found`);
        continue;
      }

      // If the transaction expired on the chain. Make a log entry and send
      // to VA. Otherwise log and loop.
      if (e.name === 'TransactionExpiredBlockheightExceededError') {
        console.log(`${new Date().toISOString()} ERROR: Blockhash expired/block height exceeded. TX failure sent to VA.`);
      } else {
        console.log(`${new Date().toISOString()} ERROR: ${e.name}`);
        console.log(e.message);
        console.log(e);
        console.log(JSON.stringify(e));
        continue;
      }

      // Need to submit a fake signature to pass the import filters
      signature = fakeSignature;
      txSuccess = false;
    } 
    const txEnd = new Date();
    const txElapsedMs = txEnd - txStart;

    // Sleep a little here to ensure the signature is on an RPC node.
    await new Promise(r => setTimeout(r, sleepMsRpc));

    // console.log(signature);
    if (signature !== fakeSignature){
      // Capture the slotLanded
      let txLanded = await connection.getTransaction(signature);
      slotLanded = txLanded.slot;
    }

    // prepare the payload to send to validators.app
    const payload = JSON.stringify({
      time: txElapsedMs,
      signature: signature,
      transaction_type: 'transfer',
      success: txSuccess,
      application: 'web3',
      commitment_level: commitmentLevel,
      slot_sent: slotSent,
      slot_landed: slotLanded
    });

    if (VERBOSE_LOG) {
      console.log(`${new Date().toISOString()} ${payload}`);
    }

    // Send the ping data to validators.app
    restClient.open(
      'POST',
      'https://www.validators.app/api/v1/ping-thing/mainnet'
    );
    restClient.setRequestHeader('Content-Type', 'application/json');
    restClient.setRequestHeader('Token', VA_API_KEY);
    restClient.send(payload);

    // Reset the try counter
    tryCount = 0;
  } catch (e) {
    console.log(`${new Date().toISOString()} ERROR: ${e.name}`);
    console.log(`${new Date().toISOString()} ERROR: ${e.message}`);
    if (++tryCount === maxTries) throw e;
  }
  // close the subscription
  connProcessed.removeSlotChangeListener(subscriptionId);
}
