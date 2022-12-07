import {Presets, SingleBar} from 'cli-progress';
import {CopyrightParser} from './Parsers/CopyrightParser';
import {CycloneDXParser} from './Parsers/CycloneDXParser';
import {FileReader} from '../Adapter/Import/FileReader';
import {Downloader} from './Downloader';
import {PackageInfo} from './Model/PackageInfo';
import {PDFFileWriter} from '../Adapter/Export/PDFFileWriter';
import {PDFParser} from './Parsers/PDFParser';
import {existsSync, mkdirSync} from 'fs';
import * as path from 'path';
import {JSONFileWriter} from '../Adapter/Export/JSONFileWriter';
import {JSONConverter} from './JSONConverter';
import {printError, printWarning} from '../Logging/ErrorFormatter';
import {CycloneDX} from './Model/CycloneDX';
import {Logger, LogLevel} from '../Logging/Logging';

/**
 * This class is responsible for distributing the different tasks to the responsible classes.
 */
export class LicenseChecker {
    progBar!: SingleBar;
    downloader!: Downloader;
    parser!: CycloneDXParser;
    packageInfos!: PackageInfo[];
    licenseTexts: Map<string, string> = new Map();
    bomPath!: string;
    bomData!: CycloneDX;
    missingValuesPath!: string;
    localDataPath!: string;
    localData: PackageInfo[] = [];
    noCopyrightList: PackageInfo[] = []; // Packages where the copyright has not been found for
    toBeAppended: PackageInfo[] = []; // Packages that are in the input file but not generated by cdxgen
    fileReader!: FileReader;
    pdfExportPath = 'bom.pdf';

    /**
     * Initializes the correct parser for the given BOM format.
     */
    async init(bomFormat: string, bomPath: string, localDataPath: string, missingValues: string): Promise<void> {
        this.downloader = new Downloader();
        await this.downloader.authenticateGithubClient();
        this.fileReader = new FileReader();
        this.bomPath = bomPath;
        this.missingValuesPath = missingValues;
        this.localDataPath = localDataPath;
        const dataFormat = bomPath.split('.').pop();
        if (!dataFormat) {
            // data format is the file format and currently only json is supported
            Logger.getInstance().addToLog(`Invalid file format of ${bomPath}. Currently only JSON files are supported.`, LogLevel.ERROR);
            printError(`Error: Invalid file format of ${bomPath}. Currently only JSON files are supported.`);
            process.exit(1);
        }
        switch (bomFormat) {
            // bomFormat is the actual format of the bom object, currently only cycloneDX is supported
            case 'cycloneDX':
                this.parser = new CycloneDXParser(dataFormat);
                break;
            default:
                Logger.getInstance().addToLog(`Unsupported Bom Format ${bomFormat}. Currently only CycloneDX format is supported.`, LogLevel.ERROR);
                printError(`Error: Unsupported Bom Format ${bomFormat}. Currently only CycloneDX format is supported.`);
                process.exit(1);
        }
    }

    /**
     * Extracts the package information from the BOM file and saves them in a list of PackageInfo objects.
     */
    retrievePackageInfos(): void {
        try {
            this.bomData = this.parser.parseInput(this.fileReader.readInput(this.bomPath));
            this.packageInfos = this.parser.parseCycloneDX(this.bomData);
        } catch (err) {
            Logger.getInstance().addToLog(`Unable to parse ${this.bomPath}. Please ensure that it has the correct format (CycloneDX).`, LogLevel.ERROR);
            printError(`Error: Unable to parse ${this.bomPath}. Please ensure that it has the correct format (CycloneDX).`);
            process.exit(1);
        }
    }

    /**
     * Downloads package data, namely the license texts and the readme.
     */
    async extractCopyrightForAllPackages() {
        console.log('Retrieving License Information...');
        this.progBar = new SingleBar({}, Presets.shades_classic);
        this.progBar.start(this.packageInfos.length, 0);
        await Promise.all(this.packageInfos.map((packageInfo) => this.checkExternalReferences(packageInfo)));
        this.progBar.stop();
        console.log('Done!');
    }

    /**
     * Checks if external references are available and downloads them.
     */
    async checkExternalReferences(packageInfo: PackageInfo) {
        for (const url of packageInfo.externalReferences) {
            if (packageInfo.copyright !== '') {
                break;
            }
            const [license, readme] = await this.downloadLicense(url);
            if (license != '') {
                packageInfo.copyright = this.parseCopyright(license);
            }
            if (readme != '' && packageInfo.copyright === '') {
                packageInfo.copyright = this.parseCopyright(license);
            }
        }
        this.progBar.increment();
    }

    /**
     * Checks the GitHub rate limit and triggers the Download of the License info.
     */
    async downloadLicense(url: string) {
        const {remaining, reset} = await this.downloader.getRemainingRateObj();
        // Checks how many request are still available to make to GitHub
        if (remaining < 1) {
            const waitTime = Math.abs(reset * 1000 - Date.now()) + 10000;
            Logger.getInstance().addToLog('GitHub Request limit reached. Waiting for ' + waitTime + 'ms.', LogLevel.WARNING);
            await new Promise(r => setTimeout(r, waitTime));
        }
        return await this.downloader.downloadLicenseAndREADME(url);
    }

    /**
     * Coordinates the parsing of the downloaded license files.
     */
    parseCopyright(source: string): string {
        const copyrightParser = new CopyrightParser();
        let copyright = copyrightParser.extractCopyright(source);
        if (copyright != '') {
            copyright = copyrightParser.removeOverheadFromCopyright(copyright);
        }
        return copyright;
    }

    /**
     * Extracts the package information from the file with default values and saves them in a list of PackageInfo objects.
     */
    retrieveLocalData(): void {
        if (!this.localDataPath) return;
        if (!existsSync(this.localDataPath)) {
            printWarning(`Error: Defaults file ${this.localDataPath} not found. Default values will be ignored.`);
            Logger.getInstance().addToLog(`Error: Defaults file ${this.localDataPath} not found. Default values will be ignored.`, LogLevel.ERROR);
            return;
        }
        const localRawData = JSON.parse(this.fileReader.readInput(this.localDataPath));
        this.localData = this.parser.parseCycloneDX(localRawData);
    }

    /**
     * Combines the information that has been retrieves through external references and the ones given by the user.
     */
    combine(): void {
        const local: PackageInfo[] = this.localData;
        const generated: PackageInfo[] = this.packageInfos;
        for (let i = 0; i < local.length; i++) {
            let localDataAdded = false; // change name
            for (let j = 0; j < generated.length; j++) {
                if (
                    generated[j].samePackage(local[i]) && generated[j].isVersionInRangeOf(local[i])
                ) {
                    generated[j].licenses = local[i].licenses;
                    generated[j].copyright = local[i].copyright;
                    localDataAdded = true;
                    // Packages of the same name and group but with different versions
                } else if (generated[j].samePackage(local[i])) {
                    localDataAdded = true;
                    this.toBeAppended.push(local[i]);
                    printWarning('Warning: Version of package did not match in the given local file: ' + local[i].toString() + ' and the generated file by cdxgen: ' + generated[j].toString() + ' possible duplicate created.');
                    Logger.getInstance().addToLog('Version of package did not match in the given local file: ' + local[i].toString() + ' and the generated file by cdxgen: ' + generated[j].toString() + ' possible duplicate created.', LogLevel.WARNING);
                }
            }
            if (!localDataAdded) {
                this.toBeAppended.push(local[i]);
            }
        }
    }

    /**
     * Creates the out dir.
     */
    createOutputDir() {
        try {
            if (!existsSync(path.join('out'))) {
                mkdirSync(path.join('out'));
            }
        } catch (err) {
            printError(err);
            Logger.getInstance().addToLog('Failed to create the out directory', LogLevel.ERROR);
            printError('Error: Failed to create the out directory');
            process.exit(1);
        }
    }

    /**
     * Exports updatedBom.json file and the file tracking packages with missing license/copyright
     */
    exportJSON(): void {
        const jsonParser = new JSONConverter();
        const jsonFileWriter = new JSONFileWriter();
        try {
            // Adding copyrights to packages
            this.bomData = jsonParser.insertCopyrightIntoBom(
                this.packageInfos,
                this.bomData
            );
            // Adding entries which are in the input file but missing in the generated file
            this.bomData = jsonParser.addMissingEntries(this.toBeAppended, this.bomData);

            // this.packageInfos.filter()
            this.packageInfos.forEach((packageInfo) => {
                if (packageInfo.copyright === '') {
                    printWarning('Warning: Failed to collect the necessary information for ' + packageInfo.toString());
                    Logger.getInstance().addToLog('Failed to collect the necessary information for ' + packageInfo.toString(), LogLevel.WARNING);
                    this.noCopyrightList.push(packageInfo);
                }
            });


            // Parse packageInfo into an array of Json objects
            const resultMissingValues = jsonParser.parsePkgInfo(
                this.noCopyrightList
            );
            // Stringify results so that they can be written
            const stringBom = JSON.stringify(this.bomData, null, 4);
            const stringMissingValues = JSON.stringify(resultMissingValues, null, 4);

            const newFile = path.join('out', 'updatedBom.json');
            jsonFileWriter.write(newFile, stringBom);
            jsonFileWriter.write(this.missingValuesPath, stringMissingValues);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (err: any) {
            Logger.getInstance().addToLog('Failed to export output into a json file', LogLevel.ERROR);
            Logger.getInstance().addToLog(err, LogLevel.ERROR);
            printError('Error: Failed to export output into a json file');
            process.exit(1);
        }
    }

    /**
     * Checks which licenses are present in the report and triggers downloads for each license text.
     */
    async getLicenseTexts() {
        const licenses = await this.downloader.getLicenses();
        if (!licenses) {
            printError('Error: Unable to retrieve License texts.');
            process.exit(1);
        }
        const licensesIdsInSbom = new Set<string>();
        for (const pkg of this.packageInfos) {
            if (pkg.licenses[0]) {
                const pkgLicenseId = pkg.licenses[0].id ?? pkg.licenses[0].name ?? '';
                if (pkgLicenseId === '') {
                    continue;
                }
                if (!licenses.some((license: { licenseId: string; }) => license.licenseId === this.filterLicenseId(pkgLicenseId))) {
                    printWarning(`Warning: Unable to retrieve License text for package ${pkg.name} with license ${pkgLicenseId}.`);
                    Logger.getInstance().addToLog(`Warning: Unable to retrieve License text for package ${pkg.name} with license ${pkgLicenseId}.`, LogLevel.WARNING);
                    continue;
                }
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                licensesIdsInSbom.add(licenses.find((license: { licenseId: string; }) => license.licenseId === this.filterLicenseId(pkgLicenseId))!.licenseId);
            }
        }
        for (const pkgLicenseId of licensesIdsInSbom) {
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            const licenseDetailsUrl = licenses.find((license: { licenseId: string; }) => license.licenseId === this.filterLicenseId(pkgLicenseId))!.detailsUrl;
            this.licenseTexts.set(pkgLicenseId, await this.downloader.downloadLicenseText(licenseDetailsUrl) ?? '');
        }
    }

    /**
     * Filters the license ID from the given LicenseID entry.
     * (Necessary because sometimes to Licenses are given i.e. "MIT or Apache")
     */
    private filterLicenseId(pkgLicenseId: string) {
        if (pkgLicenseId.match(new RegExp(' or ', 'i'))) {
            pkgLicenseId = pkgLicenseId.replace(/[()]/g, '');
            return pkgLicenseId.split(new RegExp(' or ', 'i'))[0];
        }
        if (pkgLicenseId.match(new RegExp(' and ', 'i'))) {
            pkgLicenseId = pkgLicenseId.replace(/[()]/g, '');
            return pkgLicenseId.split(new RegExp(' and ', 'i'))[0];
        }
        return pkgLicenseId;
    }

    /**
     * Exports updatedBom.pdf file
     */
    exportPDF(): void {
        try {
            const pdfParser = new PDFParser();
            const pdfExporter = new PDFFileWriter();
            // Concat the missing values for pdf export
            this.packageInfos = this.packageInfos.concat(this.toBeAppended);
            const [chead, cbody] = pdfParser.parse(this.packageInfos);
            pdfExporter.export(chead, cbody, this.licenseTexts, this.pdfExportPath);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (err: any) {
            Logger.getInstance().addToLog(err, LogLevel.ERROR);
            printError(err);
        }
    }

    /**
     * Checks whether the bom contains license information for the given package.
     */
    hasLicense(packageInfo: PackageInfo): boolean {
        return (
            Array.isArray(packageInfo['licenses']) &&
            packageInfo['licenses'].length > 0
        );
    }

    /**
     * Checks whether the bom contains external references for the given package.
     */
    hasExternalRefs(packageInfo: PackageInfo): boolean {
        return (
            Array.isArray(packageInfo['externalReferences']) &&
            packageInfo['externalReferences'].length > 0
        );
    }
}
