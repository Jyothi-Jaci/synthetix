const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const ethers = require('ethers');

let provider;
let signer;

const DATA_FILE = 'test/gas/measurements.json';
const DEPLOYMENT_PATH = './publish/deployed/local-ovm';
const MAX_SYNTHS = 10;
const NUM_MEASUREMENTS = 3;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

describe('Gas measurements', () => {
	let data;
	before('prepare data file', () => {
		if (fs.existsSync(DATA_FILE)) {
			fs.unlinkSync(DATA_FILE);
		}

		data = {};
	});

	before('set up provider & signers', async () => {
		provider = new ethers.providers.JsonRpcProvider('http://localhost:8545');

		signer = provider.getSigner(0);
		signer.address = await signer.getAddress();
		console.log(chalk.blue(`Signer: ${signer.address}`));
	});

	// ------------------------
	// CONTRACTS
	// ------------------------
	let Synthetix, Issuer, ExchangeRates, DebtCache, ReadProxyAddressResolver, SystemSettings;

	before('connect to contracts', async () => {
		Synthetix = _getContract({ name: 'Synthetix' });
		Issuer = _getContract({ name: 'Issuer' });
		ExchangeRates = _getContract({ name: 'ExchangeRates' });
		DebtCache = _getContract({ name: 'DebtCache' });
		ReadProxyAddressResolver = _getContract({ name: 'ReadProxyAddressResolver' });
		SystemSettings = _getContract({ name: 'SystemSettings' });
	});

	// ------------------------
	// SETTINGS
	// ------------------------
	before('tweak system settings', async () => {
		let tx = await SystemSettings.setMinimumStakeTime(0);
		await tx.wait();

		tx = await SystemSettings.setWaitingPeriodSecs(0);
		await tx.wait();

		tx = await SystemSettings.setRateStalePeriod(1000000000000000);
		await tx.wait();
	});

	before('remove all synths', async () => {
		const currencyKeys = await Issuer.availableCurrencyKeys();
		const synthsToRemove = currencyKeys.filter(
			currencyKey => ethers.utils.parseBytes32String(currencyKey) !== 'sUSD'
		);

		if (synthsToRemove.length > 0) {
			console.log(
				chalk.magenta(
					`Removing synths: ${synthsToRemove.map(currencyKey =>
						ethers.utils.parseBytes32String(currencyKey)
					)}`
				)
			);
			const tx = await Issuer.removeSynths(synthsToRemove);
			await tx.wait();
		}
	});

	before('set initial rates and debt cache', async () => {
		const currencyKeys = ['SNX', 'ETH'].map(currency => ethers.utils.formatBytes32String(currency));
		const rates = currencyKeys.map(() => ethers.utils.parseEther('1'));
		const { timestamp } = await provider.getBlock();

		let tx = await ExchangeRates.updateRates(currencyKeys, rates, timestamp);
		await tx.wait();

		tx = await DebtCache.takeDebtSnapshot();
		await tx.wait();
	});

	for (let numSynths = 1; numSynths <= MAX_SYNTHS; numSynths++) {
		describe(`When the system has ${numSynths} synths`, () => {
			// ------------------------
			// DATA
			// ------------------------
			let target;

			before('prepare data', () => {
				target = data[`${numSynths}_synths`] = {
					minting: { measurements: [], avg: 0 },
					burning: { measurements: [], avg: 0 },
					exchanging: { measurements: [], avg: 0 },
					claiming: { measurements: [], avg: 0 },
				};
			});

			// ------------------------
			// ADD SYNTH
			// ------------------------
			before('add synths', async () => {
				const activeSynths = await Issuer.availableSynthCount();
				console.log(chalk.blue(`Taking measurements with ${numSynths} synths...`));
				console.log(chalk.gray(`System synths: ${activeSynths}`));

				if (activeSynths < numSynths) {
					const currency = `s${numSynths - 1}`;
					console.log(chalk.magenta(`Adding a synth: ${currency}`));

					const synth = await _deploySynth({
						currency: `s${numSynths - 1}`,
						resolverAddress: ReadProxyAddressResolver.address,
					});

					let tx = await Issuer.addSynth(synth.address);
					await tx.wait();

					const { timestamp } = await provider.getBlock();
					tx = await ExchangeRates.updateRates(
						[ethers.utils.formatBytes32String(currency)],
						[ethers.utils.parseEther('1')],
						timestamp
					);
					await tx.wait();

					tx = await DebtCache.takeDebtSnapshot();
					await tx.wait();

					console.log(chalk.gray(`Updated system synths: ${await Issuer.availableSynthCount()}`));
				}
			});

			// ------------------------
			// PRINT
			// ------------------------
			after('print data', () => {
				// Stdout
				Object.keys(data).map(numSynthsKey => {
					const entry = data[numSynthsKey];
					console.log(numSynthsKey);

					Object.keys(entry).map(measurementKey => {
						const measurement = entry[measurementKey];
						console.log('  ', measurementKey, Math.ceil(measurement.avg));
					});
				});

				// File
				fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
			});

			it('take measurements', async () => {
				async function measureGas({ tx, target }) {
					let gasUsed;
					try {
						const receipt = await tx.wait();
						gasUsed = receipt.cumulativeGasUsed.toNumber();
					} catch (err) {
						gasUsed = 9000000;
					}
					target.measurements.push(gasUsed);

					const numMeasurements = target.measurements.length;
					target.avg = target.measurements.reduce((acum, val) => acum + val, 0) / numMeasurements;
				}

				// ------------------------
				// MEASUREMENTS
				// ------------------------
				for (let i = 0; i < NUM_MEASUREMENTS; i++) {
					// Minting
					await measureGas({
						tx: await Synthetix.issueSynths(ethers.utils.parseEther('100')),
						target: target.minting,
					});

					// Exchanging
					if (numSynths >= 2) {
						const targetSynth = `s${numSynths - 1}`;
						await await measureGas({
							tx: await Synthetix.exchange(
								ethers.utils.formatBytes32String(`sUSD`),
								ethers.utils.parseEther('1'),
								ethers.utils.formatBytes32String(targetSynth)
							),
							target: target.exchanging,
						});
						await measureGas({
							tx: await Synthetix.exchange(
								ethers.utils.formatBytes32String(targetSynth),
								ethers.utils.parseEther('1'),
								ethers.utils.formatBytes32String(`sUSD`)
							),
							target: target.exchanging,
						});
					}

					// Claiming
					// await _fastForward({ seconds: feePeriodDuration });
					// tx = await DebtCache.takeDebtSnapshot();
					// await tx.wait();
					// tx = await Synthetix.mint();
					// await tx.wait();
					// tx = await FeePool.closeCurrentFeePeriod();
					// await tx.wait();
					// await measureGas({
					// 	tx: await FeePool.claimFees(),
					// 	target: target.claiming,
					// });

					// Burning
					await measureGas({
						tx: await Synthetix.burnSynths(ethers.utils.parseEther('50')),
						target: target.burning,
					});
				}
			});
		});
	}
});

async function _deploySynth({ currency, resolverAddress }) {
	const currencyKey = ethers.utils.formatBytes32String(currency);

	const TokenState = _getContractFactory({ name: 'TokenStatesUSD' });
	const tokenState = await TokenState.deploy(signer.address, ZERO_ADDRESS);

	const Proxy = _getContractFactory({ name: 'ProxysUSD' });
	const proxy = await Proxy.deploy(signer.address);

	const Synth = _getContractFactory({ name: 'SynthsUSD' });
	const synth = await Synth.deploy(
		proxy.address,
		tokenState.address,
		`Mock Synth`,
		currency,
		signer.address,
		currencyKey,
		0,
		resolverAddress
	);

	let tx;

	tx = await tokenState.setAssociatedContract(synth.address);
	await tx.wait();

	tx = await proxy.setTarget(synth.address);
	await tx.wait();

	tx = await synth.setProxy(proxy.address);
	await tx.wait();

	tx = await synth.rebuildCache();
	await tx.wait();

	return synth;
}

function _getContractFactory({ name }) {
	const deployment = _getDeploymentFile({ filename: 'deployment.json' });

	const target = deployment.targets[name];
	const source = target.source;

	const bytecode = deployment.sources[source].bytecode;
	const abi = deployment.sources[source].abi;

	return new ethers.ContractFactory(abi, bytecode, signer);
}

function _getContract({ name }) {
	const deployment = _getDeploymentFile({ filename: 'deployment.json' });

	const target = deployment.targets[name];
	const address = target.address;

	const source = target.source;
	const abi = deployment.sources[source].abi;

	return new ethers.Contract(address, abi, signer);
}

function _getDeploymentFile({ filename }) {
	return JSON.parse(fs.readFileSync(path.join(DEPLOYMENT_PATH, filename), 'utf8'));
}